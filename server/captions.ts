import { venvPython } from './platform.ts';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { renderTimeline, type RenderRequest } from './media.ts';
import { validateWords, type CaptionWord } from '../src/services/captions.ts';
import { audioEffectNames } from '../src/services/effects.ts';
import { killProcessTree } from './processTree.ts';
import { gpuJob } from './workQueue.ts';

export const captionPython=()=>process.env.FRAME_LINE_CAPTION_PYTHON||venvPython('.venv-captions');
export const captionAvailable=()=>existsSync(captionPython());
function processFile(command:string,args:string[],signal:AbortSignal,progress?:(stage:string,progress:number)=>void) {
  return new Promise<void>((resolve,reject)=>{
    if(signal.aborted){reject(new Error('Cancelled'));return;}
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});let error='',buffer='';
    const abort=()=>killProcessTree(child);signal.addEventListener('abort',abort,{once:true});
    child.stdout.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>100000){killProcessTree(child);return;}const lines=buffer.split('\n');buffer=lines.pop()||'';for(const line of lines){try{const event=JSON.parse(line);if(typeof event.stage==='string'&&Number.isFinite(event.progress))progress?.(event.stage.slice(0,160),Math.max(0,Math.min(100,event.progress)));}catch{ /* Library diagnostics are not progress. */ }}});
    child.stderr.on('data',chunk=>error=(error+chunk.toString()).slice(-5000));
    child.on('error',reject);child.on('close',code=>{signal.removeEventListener('abort',abort);code===0?resolve():reject(new Error(signal.aborted?'Cancelled':error.trim()||`Speech worker exited (${code}).`));});
  });
}
/** `leaveQueue` runs once the audio is rendered, before the transcription waits for the GPU. */
export async function transcribeTimeline(request:RenderRequest,trackIds:string[],progress:(stage:string,value:number)=>void,leaveQueue?:()=>void):Promise<CaptionWord[]> {
  if(!captionAvailable())throw new Error('Local speech models are not installed. Run npm run setup:captions on the server.');
  const signal=request.signal!,start=Number(request.settings.rangeIn),end=Number(request.settings.rangeOut);
  const directory=await mkdtemp(join(tmpdir(),'frameline-transcription-'));
  try {
    const tracks=request.tracks.map(t=>({...t,hidden:true,muted:t.muted||(t.timelineId===request.timeline.id&&trackIds.length>0&&!trackIds.includes(t.id))}));
    const clips=request.clips.filter(c=>!['frameline-title','frameline-shape'].includes(c.mediaId)&& (c.mediaId==='frameline-composition'||request.assets.some(a=>a.asset.id===c.mediaId&&a.asset.hasAudio))).map(c=>({...c,transition:'',properties:{...c.properties,transitionOut:'',blendMode:'Normal',stabilization:false},effects:c.effects.filter(e=>audioEffectNames.includes(e.name)),keyframes:Object.fromEntries(Object.entries(c.keyframes??{}).filter(([k])=>/^properties\.(speed|reverse|freeze|gain|pan|normalize|audioFadeIn|audioFadeOut)$/.test(k)||k.startsWith('effects.')))}));
    const files:string[]=[];
    for(let from=start;from<end;from+=60) {
      const outputPath=join(directory,`audio-${files.length}.mov`),to=Math.min(end,from+60);
      progress('Preparing timeline audio',10*(from-start)/(end-start));
      await renderTimeline({...request,project:{...request.project,resolution:'16 × 16'},clips,tracks,nodes:[],outputPath,settings:{...request.settings,resolution:'16 × 16',codec:'Apple ProRes 4444',audio:'Linear PCM · 24-bit · 48 kHz',rangeIn:String(from),rangeOut:String(to)},onProgress:undefined});
      files.push(`file '${outputPath.replaceAll('\\','/').replaceAll("'", "'\\''")}'`);
    }
    const list=join(directory,'audio.txt'),audio=join(directory,'audio.wav'),result=join(directory,'words.json');
    await writeFile(list,files.join('\n'));
    await processFile(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',list,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-t',String(end-start),audio],signal);
    leaveQueue?.();
    await gpuJob(()=>processFile(captionPython(),[resolve('scripts/transcribe.py'),audio,result],signal,progress),signal);
    const parsed=JSON.parse(await readFile(result,'utf8'));validateWords(parsed.words);
    return parsed.words.map((w:CaptionWord)=>({...w,start:w.start+start,end:Math.min(end,w.end+start)})).filter((w:CaptionWord)=>w.end>w.start);
  } finally {await rm(directory,{recursive:true,force:true});}
}
