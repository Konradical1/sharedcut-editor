import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { isCaption } from '../src/services/captions.ts';
import { getText, drawText, validateText } from '../src/services/text.ts';
import { evaluateClip, fadeLevel } from '../src/services/animation.ts';
import { sourceTime } from '../src/services/playback.ts';
import { renderTimeline, type RenderRequest } from './media.ts';

export function registerCaptionFonts() {
  for(const [file,name] of [['TikTokSans.ttf','TikTok Sans'],['Montserrat.ttf','Montserrat'],['BarlowCondensed-Bold.ttf','Barlow Condensed']]) {
    const path=resolve('public/fonts',file);
    if(!GlobalFonts.has(name)&&existsSync(path))GlobalFonts.registerFromPath(path,name);
  }
}
registerCaptionFonts();

/** One alpha movie for all caption lines, independent of the media-input limit. */
export async function renderCaptionTimeline(request: RenderRequest) {
  const fps=Number(request.settings.fps||request.project.fps),start=Number(request.settings.rangeIn||0),end=Number(request.settings.rangeOut||request.timeline.duration);
  const [width,height]=(request.settings.resolution||request.project.resolution).split(/[×x]/).map(Number);
  const [pw,ph]=request.project.resolution.split(/[×x]/).map(Number);
  if(!Number.isFinite(fps)||fps<1||fps>120||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>21600||end>request.timeline.duration||[width,height,pw,ph].some(n=>!Number.isInteger(n)||n<16||n>4096||n%2))throw new Error('Invalid caption export range or dimensions.');
  const captions=request.clips.filter(c=>c.timelineId===request.timeline.id&&isCaption(c)&&!c.disabled&&c.start<end&&c.start+c.duration>start&&!request.tracks.find(t=>t.id===c.trackId)?.hidden).sort((a,b)=>a.start-b.start);
  for(const c of captions){if(c.effects.some(e=>e.enabled)||['cropLeft','cropRight','cropTop','cropBottom'].some(k=>Number(c.properties[k]??0)))throw new Error('Caption lines use caption presets. Remove clip effects or cropping before export.');const doc=getText(c);validateText(doc);for(const run of doc.runs)if(!GlobalFonts.has(run.style.fontFamily))throw new Error(`Missing caption font: ${run.style.fontFamily}`);}
  request.onStage?.('Rendering captions');
  const directory=await mkdtemp(join(tmpdir(),'frameline-captions-'));
  const output=join(directory,'captions.mov');
  const child=spawn(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-y','-f','rawvideo','-pixel_format','rgba','-video_size',`${width}x${height}`,'-framerate',String(fps),'-i','pipe:0','-an','-c:v','prores_ks','-threads','2','-profile:v','4','-pix_fmt','yuva444p10le',output],{stdio:['pipe','ignore','pipe']});
  let error='',failure:Error|undefined;
  child.stderr.on('data',b=>error=(error+b).slice(-4000));
  child.stdin.on('error',e=>{failure=e;});
  const done=new Promise<void>((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(request.signal?.aborted?'Cancelled':`Caption render failed: ${error||code}`)));});
  void done.catch(()=>{});
  const abort=()=>child.kill('SIGKILL');request.signal?.addEventListener('abort',abort,{once:true});
  try {
    const canvas=createCanvas(width,height),ctx=canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    const count=Math.ceil((end-start)*fps-1e-7);let cursor=0,active:typeof captions=[];
    for(let frame=0;frame<count;frame++) {
      if(request.signal?.aborted)throw new Error('Cancelled');if(failure)throw failure;
      const time=start+frame/fps;
      while(cursor<captions.length&&captions[cursor].start<=time)active.push(captions[cursor++]);
      active=active.filter(c=>c.start+c.duration>time);
      ctx.clearRect(0,0,width,height);
      for(const original of [...active].sort((a,b)=>(request.tracks.find(t=>t.id===a.trackId)?.number??0)-(request.tracks.find(t=>t.id===b.trackId)?.number??0))) {
        const c=evaluateClip(original,time,fps),p=c.properties;
        ctx.save();ctx.globalAlpha=Number(p.opacity??100)/100*fadeLevel(c,time);
        const ax=width/2+Number(p.anchorX??0)*width/pw,ay=height/2+Number(p.anchorY??0)*height/ph;
        ctx.translate(ax+Number(p.x??0)*width/pw,ay+Number(p.y??0)*height/ph);ctx.rotate(Number(p.rotation??0)*Math.PI/180);ctx.scale(Number(p.zoom??100)/100,Number(p.zoom??100)/100);ctx.translate(-ax,-ay);
        drawText(ctx,getText(c),width,height,pw,ph,sourceTime(original,time,fps));ctx.restore();
      }
      if(!child.stdin.write(Buffer.from(ctx.getImageData(0,0,width,height).data)))await Promise.race([once(child.stdin,'drain'),done.then(()=>{throw new Error('Caption encoder closed early');})]);
      request.onProgress?.((frame+1)/count*30);
    }
    child.stdin.end();await done;
    const trackId='caption-render-track',mediaId='caption-render-media';
    const track={id:trackId,timelineId:request.timeline.id,name:'Captions',kind:'video' as const,number:Math.max(0,...request.tracks.map(t=>t.number))+1,hidden:false,muted:true,solo:false,locked:false,gain:0,pan:0};
    const clip={id:mediaId,mediaId,projectId:request.project.id,timelineId:request.timeline.id,trackId,name:'Captions',start,duration:end-start,sourceIn:0,color:'#9b86d6',disabled:false,properties:{},effects:[]};
    await renderTimeline({...request,clips:[...request.clips.filter(c=>c.timelineId!==request.timeline.id||!isCaption(c)),clip],tracks:[...request.tracks,track],assets:[...request.assets,{path:output,asset:{id:mediaId,projectId:request.project.id,name:'Captions',kind:'video',binId:'',thumbnail:'',duration:(Math.ceil((end-start)*fps))/fps,resolution:`${width} × ${height}`,fps,size:'',status:'ready',progress:100,hasAudio:false,inputProfile:'Rec.709'}}],onProgress:p=>request.onProgress?.(30+p*.7)});
  } finally {request.signal?.removeEventListener('abort',abort);child.kill('SIGKILL');await done.catch(()=>{});await rm(directory,{recursive:true,force:true});}
}
