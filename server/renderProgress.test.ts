import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run, renderTimeline, probeMedia, type RenderRequest } from './media.ts';
import { starterGrade } from '../src/services/color.ts';
import { venvPython } from './platform.ts';

test('native progress reads split JSON from either stream without swallowing failures', async () => {
  for (const stream of ['stdout', 'stderr'] as const) {
    const progress: number[] = [];
    await run(process.execPath, ['-e', `process.${stream}.write('diagnostic\\n{"pro');setTimeout(()=>process.${stream}.write('gress":25}\\n{"progress":80}\\n'),20)`], { jsonProgress: stream === 'stderr' ? 'stderr' : true, onProgress: p => progress.push(p) });
    assert.deepEqual(progress, [25, 80]);
  }
  await assert.rejects(run(process.execPath, ['-e', 'console.error("broken encoder");process.exit(1)'], { jsonProgress: 'stderr' }), /broken encoder/);
});

test('ACES export reports its color stage before encoding, stays monotonic, and finishes a playable file', { timeout: 60000, skip: !existsSync(process.env.FRAME_LINE_COLOR_PYTHON || venvPython('.venv-color')) }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'render-progress-'));
  try {
    const input = path.join(dir, 'input.mp4');
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-v','error','-y','-f','lavfi','-i','color=c=red:s=64x64:r=24:d=0.5','-c:v','libx264',input]);
    const clip = { id:'c',projectId:'p',timelineId:'t',trackId:'v',mediaId:'a',name:'Color sample',start:0,duration:.5,sourceIn:0,color:'red',disabled:false,properties:{colorPipeline:'nodes-v2',inputProfile:'S-Log3',inputGamut:'S-Gamut3.Cine'},effects:[] } as RenderRequest['clips'][number];
    let id=0; const nodes=starterGrade(clip, undefined, ()=>String(++id));
    for (const effect of nodes.at(-1)!.effects ?? []) if (effect.type==='cst') Object.assign(effect,{toneMapping:'aces2',gamutMapping:'none'});
    const progress: number[] = [], stages: string[] = [];
    const outputPath=path.join(dir,'output.mp4');
    const request:RenderRequest={ project:{id:'p',resolution:'64 × 64',fps:24} as RenderRequest['project'],timeline:{id:'t',projectId:'p',name:'Test',duration:.5}, clips:[clip],nodes,
      tracks:[{id:'v',timelineId:'t',name:'Video',kind:'video',number:1,muted:false,hidden:false,solo:false,locked:false,gain:0,pan:0}],
      assets:[{path:input,asset:{id:'a',projectId:'p',name:'source',kind:'video',duration:.5,fps:24,resolution:'64 × 64',binId:'',size:'',thumbnail:'',status:'ready',progress:100}}],
      settings:{codec:'H.264',audio:'Disabled'},outputPath,onProgress:p=>progress.push(p),onStage:s=>stages.push(s) };
    await renderTimeline(request);
    assert.ok(stages.some(s=>s.startsWith('Processing color')), 'The color stage reaches the caller');
    assert.equal(stages.at(-1),'Encoding video and audio');
    assert.ok(progress.some(p=>p>0 && p<50), 'Preparation owns part of overall progress');
    assert.ok(progress.every((p,i)=>!i || p>=progress[i-1]), String(progress));
    assert.equal(progress.at(-1),100);
    assert.ok(Math.abs((await probeMedia(outputPath)).duration-.5)<.05);
    await renderTimeline({...request,clips:[{...clip,sourceIn:1/48,properties:{...clip.properties,freeze:true}}],onProgress:undefined,onStage:undefined});
    assert.ok(Math.abs((await probeMedia(outputPath)).duration-.5)<.05,'A freeze between source timestamps still decodes and holds one graded frame.');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
