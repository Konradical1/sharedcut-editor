// Tunes the Color Assistant looks on real shots: runs the looks pipeline in-process, reading clips, grades and originals from a data dir
// (read-only), and writes the job, a contact sheet (rows = shots; before, look 1, 2, 3) and the review draft to --out.
// node --experimental-strip-types scripts/color-assistant-tune.mjs <projectId> <clipId>... [--style "cool dramatic scene"] [--data data] [--out dir] [--name label]
// FRAME_LINE_AI_PROVIDER unset = real Codex: two calls per run (first answer + review). The frame cache under --out is reused between runs.
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {readWorkspace} from './workspace-db.mjs';
import {colorAssistantService} from '../server/colorAssistant.ts';
const args=process.argv.slice(2),flag=name=>{const i=args.indexOf(`--${name}`);return i<0?undefined:args.splice(i,2)[1];};
const style=flag('style'),data=resolve(flag('data')??'data'),out=resolve(flag('out')??join(tmpdir(),'sharedcut-color-assistant-tune')),name=flag('name')??'run',[projectId,...clipIds]=args;
if(!projectId||!clipIds.length){console.error('Usage: color-assistant-tune.mjs <projectId> <clipId>... [--style text] [--data dir] [--out dir] [--name label]');process.exit(2);}
const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
const db=new DatabaseSync(join(data,'frameline.sqlite'),{readOnly:true}),state=readWorkspace(db).state;db.close();
const service=colorAssistantService(out),started=Date.now();
const {jobId}=service.start({projectId,body:{mode:'looks',clipIds,...(style&&{prompt:style})},clips:state.clips,media:state.media,nodes:state.nodes,source:id=>join(data,'media',id,'original')});
const folder=join(out,'color-assistant',projectId,jobId),draft=join(out,`${name}-draft`);mkdirSync(draft,{recursive:true});
let job,stage;
for(;;){
 job=service.get(projectId,jobId);
 if(job.stage!==stage)console.log(`${((Date.now()-started)/1000).toFixed(1)} s  ${stage=job.stage}`);
 // The first looks' stills are overwritten after a successful review: keep a copy while the review call runs.
 if(stage==='Reviewing the looks'&&existsSync(folder))for(const file of readdirSync(folder).filter(f=>/-look\d\.jpg$/.test(f)))try{copyFileSync(join(folder,file),join(draft,file));}catch{}
 if(!['waiting','running'].includes(job.status))break;
 await new Promise(r=>setTimeout(r,250));
}
await service.close();
if(job.status!=='done'){console.error(job.status,job.error,JSON.stringify(job.skipped));process.exit(1);}
const file=url=>join(folder,url.split('/').at(-1)),codes=path=>execFileSync(ffmpeg,['-v','error','-i',path,'-f','rawvideo','-pix_fmt','rgb24','-'],{maxBuffer:1e8});
// levels = mean absolute 8-bit change; color = its part that moves the channels apart (colorDiff in color-assistant.py).
const diff=(a,b)=>{let t=0,c=0;for(let i=0;i<a.length;i+=3){const d=[0,1,2].map(k=>a[i+k]-b[i+k]),m=(d[0]+d[1]+d[2])/3;for(const v of d){t+=Math.abs(v);c+=Math.abs(v-m);}}return `${(t/a.length).toFixed(1)} (color ${(c/a.length).toFixed(1)})`;};
const sheet=(rows,path)=>{const inputs=rows.flat(),graph=rows.map((_,r)=>`${[0,1,2,3].map(c=>`[${r*4+c}]`).join('')}hstack=4[r${r}]`).join(';')+(rows.length>1?`;${rows.map((_,r)=>`[r${r}]`).join('')}vstack=${rows.length}`:`;[r0]null`);
 execFileSync(ffmpeg,['-v','error','-y',...inputs.flatMap(i=>['-i',i]),'-filter_complex',graph,'-q:v','3',path]);return path;};
const report=(label,dir)=>{const rows=job.result.stills.map(s=>[file(s.before),...s.after.map((a,i)=>a?join(dir,file(a).split(/[\\/]/).at(-1)):file(s.before))]);
 if(rows.some(r=>r.some(p=>!existsSync(p))))return;
 for(const [s,r] of job.result.stills.map((s,i)=>[s,rows[i]]))console.log(`${label} ${state.clips.find(c=>c.id===s.clipId)?.name??s.clipId} f${s.frame} meanDiff`,r.slice(1).map(p=>diff(codes(p),codes(r[0]))).join(' / '));
 console.log(`${label} sheet`,sheet(rows,join(out,`${name}-${label}.jpg`)));};
for(const look of job.result.looks)console.log(`${look.intensity}: ${look.name} - ${look.description}\n  ${JSON.stringify({...look.look,extraNodes:look.extraNodes})}`);
report('draft',draft);report('final',folder);
console.log(`done in ${((Date.now()-started)/1000).toFixed(0)} s; job ${folder}`);
