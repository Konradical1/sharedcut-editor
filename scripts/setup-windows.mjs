// Repeatable native installation for the Dell and Lenovo; no Docker or administrator required.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

if (process.platform !== 'win32') throw Error('Use the individual setup:* commands on this platform.');
const root=resolve(import.meta.dirname,'..');
for(const command of [process.env.FFMPEG_PATH||'ffmpeg',process.env.FFPROBE_PATH||'ffprobe']) {
  execFileSync(command,['-version'],{stdio:'ignore',windowsHide:true});
}
if(!process.env.npm_execpath)throw Error('Run npm run setup:windows.');
for(const script of ['setup:color','setup:imports','setup:stabilize','setup:flow','setup:tracker','setup:masks','setup:depth','setup:captions','build','doctor']) {
  console.log(`\nSharedCut: ${script}`);
  execFileSync(process.execPath,[process.env.npm_execpath,'run',script],{cwd:root,stdio:'inherit',windowsHide:true});
}
console.log('\nReady. Run npm start, then open http://localhost:4310.');
