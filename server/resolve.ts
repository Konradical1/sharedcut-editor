import { createHash } from 'node:crypto';
import type { Clip, GradeNode, MediaAsset, Project, Timeline, Track } from '../src/state/models.ts';

type RecordValue = Record<string, any>;
const array=(v:unknown):RecordValue[]=>{if(Array.isArray(v))return v;if(v&&typeof v==='object'&&!Object.keys(v).length)return [];throw new Error('Expected a Resolve list.');};
const text=(v:unknown)=>{if(typeof v!=='string'||v.length>4096)throw new Error('Invalid Resolve text.');return v;};
const number=(v:unknown)=>{const n=typeof v==='number'?v:typeof v==='string'?Number(v):NaN;if(!Number.isFinite(n)||Math.abs(n)>1e9)throw new Error('Invalid Resolve frame or parameter.');return n;};
export const resolveRate=(v:unknown)=>{const n=number(v);if(n<=0||n>120)throw new Error('Unsupported Resolve frame rate.');const ntsc=[24000,30000,60000,120000].find(r=>Math.abs(n-r/1001)<.0015);return ntsc?ntsc/1001:n;};

/** Resolve is the parser for DRP. This consumes the explicit, versioned bridge export. */
export function importResolve(manifest:RecordValue,projectId:string,userId:string,otios:RecordValue[]) {
  if(manifest.format!=='frameline-resolve'||manifest.version!==1)throw new Error('Export this project using the SharedCut Resolve bridge (version 1).');
  const sourceTimelines=array(manifest.timelines);
  if(!Array.isArray(otios)||otios.length!==sourceTimelines.length)throw new Error('Include every timeline-N.otio from the same bridge bundle.');if(!sourceTimelines.length||sourceTimelines.length>100)throw new Error('Export 1–100 Resolve timelines.');
  const id=(kind:string,value:string)=>`${projectId}-${kind}-${createHash('sha256').update(text(value)).digest('hex').slice(0,24)}`;
  const warnings=new Set<string>(), files=new Set<string>(['project.drp','project.frameline.json']);
  const media:MediaAsset[]=[],timelines:Timeline[]=[],tracks:Track[]=[],clips:Clip[]=[],nodes:GradeNode[]=[];
  const project:Project={id:projectId,name:text(manifest.name).replace(/ — (?:FrameLine|SharedCut) (Source|Import Test)$/,''),description:'Imported from DaVinci Resolve. Original project and grade provenance retained.',shared:false,thumbnail:'',modifiedAt:Date.now(),duration:0,resolution:'1920 × 1080',fps:resolveRate(sourceTimelines[0].settings?.timelineFrameRate??24),status:'In progress',members:[{userId,role:'Owner'}]};
  for(const m of array(manifest.media)) {
    const p=m.properties||{};if(!p['File Path'])continue;
    const name=text(m.name),fps=resolveRate(p.FPS||project.fps),isAudio=p.Type==='Audio';
    const asset:MediaAsset={id:id('media',m.id),projectId,name,kind:isAudio?'audio':'video',binId:isAudio?'audio':'broll',thumbnail:'',duration:Math.max(0,number(p.Frames||0)/fps),resolution:String(p.Resolution||''),fps:isAudio?0:fps,size:'',status:'failed',progress:0,sourcePath:text(p['File Path']),hasAudio:isAudio||String(p.Type).includes('Audio'),error:'Source file not uploaded. Select its media folder to relink.'};
    media.push(asset);
  }
  if(media.length>5000)throw new Error('Import at most 5,000 source files per project.');
  for(const [ti,t] of sourceTimelines.entries()) {
    const fps=resolveRate(t.settings?.timelineFrameRate??project.fps),start=number(t.startFrame),end=number(t.endFrame);
    if(end<=start)throw new Error('Resolve timeline is empty.');
    const timeline:Timeline={id:id('timeline',t.id),projectId,name:text(t.name),duration:(end-start)/fps,markers:Object.entries(t.markers||{}).filter(([k])=>/^\d+$/.test(k)).map(([k,m]:[string,any])=>({time:Number(k)/fps,name:String(m.name||'Marker').slice(0,255),color:String(m.color||'Blue').slice(0,64),...(m.note?{note:String(m.note).slice(0,5000)}:{})}))};
    Object.assign(timeline,{frameRate:fps,startFrame:start,startTimecode:String(t.startTimecode||'00:00:00:00'),resolveId:t.id});timelines.push(timeline);files.add(`timeline-${ti+1}.otio`);
    if(ti===0){project.fps=fps;project.resolution=`${number(t.settings?.timelineResolutionWidth||1920)} × ${number(t.settings?.timelineResolutionHeight||1080)}`;project.duration=timeline.duration;}
    for(const tr of array(t.tracks)) {
      if(!['video','audio'].includes(tr.kind)){if(array(tr.items).length)warnings.add('Subtitle tracks remain in the Resolve archive; subtitle editing is unavailable.');continue;}
      const track:Track={id:id('track',t.id+tr.kind+tr.number),timelineId:timeline.id,name:text(tr.name),kind:tr.kind,number:number(tr.number),muted:tr.enabled===false,hidden:tr.kind==='video'&&tr.enabled===false,solo:false,locked:false,gain:0,pan:0};tracks.push(track);
      const otioTrack=array(otios[ti]?.tracks?.children).filter(o=>o.kind===(tr.kind==='video'?'Video':'Audio'))[number(tr.number)-1];
      if(!otioTrack)throw new Error('OTIO track does not match the manifest.');
      const otioClips=array(otioTrack.children).filter(c=>c.OTIO_SCHEMA?.startsWith('Clip.'));
      if(otioClips.length!==array(tr.items).length)throw new Error('OTIO clip count does not match the manifest.');
      if(array(otioTrack.children).some(c=>c.OTIO_SCHEMA?.startsWith('Transition.')))warnings.add(`${t.name}: transitions need a Resolve render.`);
      for(const [itemIndex,item] of array(tr.items).entries()) {
        const asset=media.find(m=>m.id===id('media',item.mediaId||''));
        if(!asset)throw new Error(`${item.name}: nested, generated, or missing media. Render this item in Resolve before importing.`);
        const otio=otioClips[itemIndex], range=otio.source_range, reference=otio.media_references?.[otio.active_media_reference_key||'DEFAULT_MEDIA']||otio.media_reference;
        if(!range||!reference?.available_range||otio.name!==item.name)throw new Error('OTIO source range does not match the manifest.');
        const duration=number(item.durationFrames),position=number(item.startFrame),sourceFps=resolveRate(range.start_time.rate);
        const sourceSeconds=number(range.start_time.value)/sourceFps-number(reference.available_range.start_time.value)/resolveRate(reference.available_range.start_time.rate);
        const inFrame=Math.round(sourceSeconds*sourceFps*1e6)/1e6;
        if(duration<=0||position<start||inFrame<-.001)throw new Error(`${item.name}: invalid source range.`);
        const warp=array(otio.effects).find(e=>e.OTIO_SCHEMA?.startsWith('LinearTimeWarp.'));
        const speed=warp?number(warp.time_scalar):1;
        if(speed<=0)throw new Error(`${item.name}: reverse or freeze retimes need a Resolve render.`);
        const p=item.properties||{},properties:Clip['properties']={speed:speed*100};
        const link=otio.metadata?.Resolve_OTIO?.['Link Group ID'];
        if(link!=null && number(link)>0)properties.linkGroup=id('link',timeline.id+':'+number(link));
        if(tr.kind==='video')properties.audioDetached=true;
        for(const e of array(otio.effects)) {
          const r=e.metadata?.Resolve_OTIO;if(!r?.Enabled)continue;
          for(const param of array(r.Parameters)) {
            if(param['Parameter ID']==='videoFaderIn')properties.fadeIn=number(param['Parameter Value'])/fps;
            else if(param['Parameter ID']==='videoFaderOut')properties.fadeOut=number(param['Parameter Value'])/fps;
            else if(JSON.stringify(param['Parameter Value'])!==JSON.stringify(param['Default Parameter Value']))warnings.add(`${item.name}: ${r.Name} requires comparison with Resolve.`);
          }
        }
        const mapping:Record<string,string>={Pan:'x',Tilt:'y',RotationAngle:'rotation',AnchorPointX:'anchorX',AnchorPointY:'anchorY',CropLeft:'cropLeft',CropRight:'cropRight',CropTop:'cropTop',CropBottom:'cropBottom',Opacity:'opacity'};
        for(const [from,to] of Object.entries(mapping))if(p[from]!=null)properties[to]=number(p[from])*(from==='Tilt'?-1:1);
        const zoomX=number(p.ZoomX??1),zoomY=p.ZoomY!=null?number(p.ZoomY):zoomX;
        if(Math.abs(zoomY-zoomX)<=.00001)properties.zoom=zoomX*100;
        else for(const [key,v] of [['scaleX',zoomX],['scaleY',zoomY]] as const){const s=Math.abs(v)*100;properties[key]=Math.min(800,Math.max(1,s));if(s<1||s>800)warnings.add(`${item.name}: Zoom beyond 1–800% is clamped.`);}
        for(const k of ['FlipX','FlipY','Pitch','Yaw','CropSoftness','CompositeMode'])if(p[k])warnings.add(`${item.name}: ${k} is retained in the archive, not reproduced.`);
        const clip:Clip={id:id('clip',item.id),projectId,timelineId:timeline.id,trackId:track.id,mediaId:asset.id,name:text(item.name),start:(position-start)/fps,duration:duration/fps,sourceIn:inFrame/sourceFps,color:tr.kind==='video'?'#668b9e':'#699781',disabled:item.enabled===false,properties,effects:[]};
        Object.assign(clip,{resolveId:item.id,resolveStartFrame:position,resolveSourceFrame:inFrame});
        if(tr.kind==='video') {
          if(item.lookExported && /^[a-zA-Z0-9_-]+\.cube$/.test(item.lookFile)) {properties.resolveLookUrl=`/api/projects/${projectId}/resolve/${item.lookFile}`;files.add(item.lookFile);}
          else warnings.add(`${item.name}: Resolve could not export the grade LUT.`);
          if(item.referenceExported && /^[a-zA-Z0-9_-]+\.png$/.test(item.referenceFile)){properties.resolveReferenceUrl=`/api/projects/${projectId}/resolve/${item.referenceFile}`;properties.resolveReferenceTime=(number(item.referenceFrame)-start)/fps;files.add(item.referenceFile);}
          properties.resolveNodeNames=array(item.nodes).map(n=>`${n.index}. ${n.name||'Node'}`).join(' → ');
          const tools=array(item.nodes).flatMap(n=>Object.entries(n.tools||{}).filter(([k])=>/^\d+$/.test(k)).map(([,v])=>String(v)));
          if(tools.some(tool=>!/Color Space Transform|Primary|HDR|Custom Curves/.test(tool)))warnings.add(`${item.name}: spatial, temporal, or additional Resolve effects need reference comparison; a LUT cannot reproduce every effect.`);
          nodes.push({id:id('grade',item.id),projectId,clipId:clip.id,name:'Correction',kind:'balance',enabled:true,order:1,parameters:{exposure:0,contrast:1,pivot:.5,saturation:100}});
        }
        clips.push(clip);
      }
    }
  }
  if(clips.length>10000)throw new Error('Import at most 10,000 timeline items.');
  if(new Set(media.map(m=>m.id)).size!==media.length||new Set(clips.map(c=>c.id)).size!==clips.length)throw new Error('Duplicate Resolve IDs.');
  warnings.add('Resolve node controls remain in the original project; SharedCut edits corrections over the exported base look.');
  warnings.add('Verify audio mixing, keyframes, retimes, transitions and effects against Resolve; the bridge does not translate every proprietary setting.');
  Object.assign(project,{resolveFiles:[...files],resolveWarnings:[...warnings],resolveImportHash:createHash('sha256').update(JSON.stringify([manifest,otios])).digest('hex')});
  return {project,media,timelines,tracks,clips,nodes,warnings:[...warnings],files:[...files]};
}

/** Write native Resolve video faders; retain other edits in explicit SharedCut metadata. */
export function exportResolveTimeline(project:Project,timeline:Timeline,tracks:Track[],clips:Clip[],media:MediaAsset[],templates:Record<string,RecordValue>={}) {
  const fps=Number((timeline as Timeline & {frameRate?:number}).frameRate)||project.fps;
  const rational=(seconds:number)=>({OTIO_SCHEMA:'RationalTime.1',rate:fps,value:Math.round(seconds*fps)});
  const range=(start:number,duration:number)=>({OTIO_SCHEMA:'TimeRange.1',start_time:rational(start),duration:rational(duration)});
  const warnings=new Set<string>();
  const children=tracks.filter(t=>t.timelineId===timeline.id).map(track=>{
    let cursor=0;
    const children:RecordValue[]=[];
    for(const clip of clips.filter(c=>c.trackId===track.id).sort((a,b)=>a.start-b.start)) {
      if(clip.start<cursor-1/fps/2)throw new Error(`${track.name}: overlapping clips cannot be represented on one Resolve track.`);
      if(clip.start>cursor+1/fps/2)children.push({OTIO_SCHEMA:'Gap.1',name:'',metadata:{},source_range:range(0,clip.start-cursor),effects:[],markers:[],enabled:true});
      const asset=media.find(m=>m.id===clip.mediaId),template=templates[String((clip as Clip & {resolveId?:string}).resolveId)];
      if(!asset)throw new Error(`${clip.name}: export titles as video before sending this timeline to Resolve.`);
      const item:RecordValue=template?structuredClone(template):{OTIO_SCHEMA:'Clip.2',metadata:{},effects:[],markers:[],media_references:{DEFAULT_MEDIA:{OTIO_SCHEMA:'ExternalReference.1',metadata:{},name:asset.name,target_url:asset.sourcePath||asset.sourceUrl,available_range:range(0,asset.duration)}},active_media_reference_key:'DEFAULT_MEDIA'};
      item.name=clip.name;item.enabled=!clip.disabled;
      const reference=item.media_references?.[item.active_media_reference_key||'DEFAULT_MEDIA']??item.media_reference;
      const sourceOrigin=reference?.available_range?.start_time;
      item.source_range=range(clip.sourceIn+(sourceOrigin?sourceOrigin.value/sourceOrigin.rate:0),clip.duration*Number(clip.properties.speed??100)/100);
      item.metadata={...item.metadata,SharedCut:{version:1,properties:clip.properties,keyframes:clip.keyframes??{},effects:clip.effects}};
      if(track.kind==='video') {
        let effect=item.effects.find((e:RecordValue)=>e.metadata?.Resolve_OTIO?.['Effect Name']==='Video Faders');
        if(!effect){effect={OTIO_SCHEMA:'Effect.1',name:'',effect_name:'Resolve Effect',metadata:{Resolve_OTIO:{'Display Type':3,'Effect Name':'Video Faders',Enabled:true,Name:'Video Faders',Parameters:[],Type:36}}};item.effects.push(effect);}
        effect.metadata.Resolve_OTIO.Enabled=true;
        for(const [key,id] of [['fadeIn','videoFaderIn'],['fadeOut','videoFaderOut']]) {
          const parameters=effect.metadata.Resolve_OTIO.Parameters as RecordValue[];
          const parameter=parameters.find(p=>p['Parameter ID']===id);
          const value=Math.round(Math.max(0,Math.min(clip.duration,Number(clip.properties[key]??0)))*fps);
          if(parameter)parameter['Parameter Value']=value;
          else parameters.push({'Default Parameter Value':0,'Parameter ID':id,'Parameter Value':value,'Variant Type':'Double',maxValue:2147483647,minValue:0});
        }
      }
      if(clip.properties.audioFadeIn||clip.properties.audioFadeOut)warnings.add('Audio fades are retained in SharedCut metadata. Resolve does not expose their native OTIO mapping through the documented bridge; use rendered audio for matching sound.');
      if(Object.keys(clip.keyframes??{}).length||clip.effects.length)warnings.add('Property keyframes and SharedCut effects are retained as SharedCut metadata. Render the timeline for matching animation in Resolve.');
      if(Number(clip.properties.scaleX??100)!==100||Number(clip.properties.scaleY??100)!==100||clip.keyframes?.['properties.scaleX']?.length||clip.keyframes?.['properties.scaleY']?.length)warnings.add('Scale X/Y stretch is retained as SharedCut metadata; Resolve shows the uniform Zoom. Render the timeline for matching framing.');
      if(Number(clip.properties.fadeOrigin??0))warnings.add('Trimmed fades retain their complete envelope in SharedCut metadata; native Resolve faders are anchored to clip edges.');
      children.push(item);cursor=clip.start+clip.duration;
    }
    return {OTIO_SCHEMA:'Track.1',name:track.name,kind:track.kind==='video'?'Video':'Audio',metadata:{},source_range:null,effects:[],markers:[],enabled:!(track.hidden||track.muted),children};
  });
  warnings.add('Native video fade lengths are synchronized. Other Resolve settings are preserved from the imported source; SharedCut transform and grade edits need a rendered export.');
  return {otio:{OTIO_SCHEMA:'Timeline.1',name:`${timeline.name} — SharedCut`,global_start_time:rational(0),metadata:{SharedCut:{version:1,warnings:[...warnings]}},tracks:{OTIO_SCHEMA:'Stack.1',name:'tracks',metadata:{},source_range:null,effects:[],markers:[],enabled:true,children}},warnings:[...warnings]};
}
