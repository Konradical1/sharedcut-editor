import { execFileSync } from 'node:child_process';
import { venvPython } from '../server/platform.ts';
import { flowWorker, flowEngineLabel } from '../server/opticalFlow.ts';
import { smartMaskCapabilities } from '../server/smartMask.ts';
import { depthCapabilities } from '../server/depth.ts';
import { denoiseCapabilities } from '../server/denoise.ts';
import { stabilizeCapabilities } from '../server/stabilize.ts';
import { motionTrackerCapabilities } from '../server/motionTracker.ts';
import { captionPython } from '../server/captions.ts';
import { getMediaCapabilities } from '../server/media.ts';
import { aiModel, aiProvider, codexCommand } from '../server/codexExec.ts';

const checks={};let failed=false;
async function check(name,work) {
  try { checks[name]=await work();if(checks[name]?.available===false)failed=true; }
  catch(error) {checks[name]={available:false,error:error.message};failed=true;}
}
const python=(command,code)=>JSON.parse(execFileSync(command,['-c',code],{encoding:'utf8',windowsHide:true,timeout:120000}));
await check('media',()=>getMediaCapabilities());
await check('opticalFlow',async()=>({available:!!await flowWorker(),engine:flowEngineLabel()}));
await check('smartMask',async()=>{const {workerIdentity,...caps}=await smartMaskCapabilities();return caps;});
await check('depth',async()=>{const {workerIdentity,...caps}=await depthCapabilities();return caps;});
await check('denoise',async()=>{const {workerIdentity,...caps}=await denoiseCapabilities();return caps;});
await check('stabilize',stabilizeCapabilities);
await check('motionTracker',motionTrackerCapabilities);
await check('captions',()=>python(captionPython(),"import json,torch,ctranslate2; from faster_whisper import WhisperModel; from whisperx.alignment import load_align_model; from silero_vad import load_silero_vad; print(json.dumps(dict(available=True,torch=torch.__version__,alignmentGpu=torch.cuda.is_available(),transcriptionGpus=ctranslate2.get_cuda_device_count())))"));
await check('color',()=>python(process.env.FRAME_LINE_COLOR_PYTHON||venvPython('.venv-color'),"import json,PyOpenColorIO as ocio; print(json.dumps(dict(available=ocio.__version__=='2.5.2',version=ocio.__version__)))"));
await check('imports',()=>python(process.env.FRAME_LINE_IMPORT_PYTHON||venvPython('.venv-import'),"import json,yt_dlp,spotdl; print(json.dumps(dict(available=True)))"));
// Color Assistant: report the Codex CLI (or the Claude key) without calling a model. Only a host that enables it (FRAME_LINE_AI_USERS) fails when it is missing.
await check('colorAssistant',()=>{const command=codexCommand(),users=!!process.env.FRAME_LINE_AI_USERS?.trim();if(aiProvider()==='anthropic'){if(users&&!process.env.ANTHROPIC_API_KEY)throw new Error('FRAME_LINE_AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY.');return{available:true,enabled:users,model:aiModel(),provider:'anthropic',key:!!process.env.ANTHROPIC_API_KEY};}let version=null;try{version=execFileSync(command,['--version'],{encoding:'utf8',windowsHide:true,timeout:30000}).trim();}catch(error){if(users)throw error;}return{available:true,enabled:users,command,version,model:aiModel(),provider:process.env.FRAME_LINE_AI_PROVIDER||'codex'};});
console.log(JSON.stringify(checks,null,2));process.exitCode=failed?1:0;
