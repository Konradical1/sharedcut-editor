// Import a Resolve bridge bundle into a running SharedCut server.
// node scripts/import-resolve.mjs /path/to/bridge-folder [--server http://127.0.0.1:4310]
// Re-running the same bundle resumes that import instead of creating a duplicate project.
import {readFile,stat,open} from 'node:fs/promises';
import {join,resolve as resolvePath,basename} from 'node:path';
import {createHash} from 'node:crypto';

for(const event of ['uncaughtException','unhandledRejection'])process.on(event,error=>{console.error('\n'+(error?.message??error));process.exit(1);});

const args=process.argv.slice(2),flag=name=>{const i=args.indexOf(name);return i<0?undefined:args.splice(i,2)[1];};
const server=(flag('--server')??process.env.FRAME_LINE_URL??'http://127.0.0.1:4310').replace(/\/$/,'');
if(!args[0])throw new Error('Pass the Resolve bridge export folder (the one holding project.frameline.json).');
const bundle=resolvePath(args[0]);

const ask=(label,hidden)=>new Promise(done=>{
  process.stdout.write(label);const input=process.stdin;input.resume();input.setEncoding('utf8');
  if(hidden&&input.isTTY)input.setRawMode(true);
  let value='';
  const read=chunk=>{for(let index=0;index<chunk.length;index++){
    const character=chunk[index];
    if(character==='\u0003'){process.stdout.write('\n');process.exit(130);}
    if(character==='\n'||character==='\r') {
      if(hidden&&input.isTTY)input.setRawMode(false);
      input.off('data',read);input.pause();
      // Hand the rest of this chunk back so a pasted or piped answer keeps its later lines.
      let rest=chunk.slice(index+1);if(character==='\r'&&rest.startsWith('\n'))rest=rest.slice(1);
      if(rest)input.unshift(rest);
      process.stdout.write('\n');return done(value.trim());
    }
    if(character==='\u007f'||character==='\b'){value=value.slice(0,-1);continue;}
    value+=character;
  }};
  input.on('data',read);
});

let cookie='';
const call=async(path,init={})=>{
  const response=await fetch(server+path,{...init,headers:{...(cookie&&{cookie}),...init.headers}});
  const body=await response.text();
  if(!response.ok)throw new Error(`${init.method??'GET'} ${path} -> ${response.status}: ${(()=>{try{return JSON.parse(body).error;}catch{return body.slice(0,300);}})()}`);
  const set=response.headers.getSetCookie?.().find(value=>value.startsWith('frameline_session='));
  if(set)cookie=set.split(';')[0];
  return body?JSON.parse(body):{};
};

const manifest=await readFile(join(bundle,'project.frameline.json'),'utf8').then(JSON.parse).catch(()=>{throw new Error(`No readable project.frameline.json in ${bundle}. Point this at the folder the Resolve bridge wrote.`);});
if(manifest.format!=='frameline-resolve')throw new Error('That folder is not a SharedCut bridge export. Run scripts/resolve-export.lua in Resolve first.');
const otios=await Promise.all(manifest.timelines.map((_,index)=>readFile(join(bundle,`timeline-${index+1}.otio`),'utf8').then(JSON.parse)));

await call('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:await ask(`Email for ${server}: `),password:await ask('Password: ',true)})});

// A deterministic ID makes a repeated run resume the same import rather than duplicate it.
const projectId='resolve-'+createHash('sha256').update(JSON.stringify([manifest,otios])).digest('hex').slice(0,32);
console.log(`Importing "${manifest.name}" -> ${projectId}`);
const imported=await call('/api/resolve/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId,manifest,otios})});
console.log(`${imported.media.length} sources, ${imported.files.length} bundle files.`);

for(const name of imported.files) {
  if(name==='project.frameline.json')continue;
  try{await call(`/api/projects/${projectId}/resolve/${name}`,{method:'PUT',body:await readFile(join(bundle,name))});}
  catch(error){if(!String(error).includes('immutable'))throw error;}
}
console.log('Grade LUTs, reference stills, OTIO and the original DRP are stored.');

for(const [index,asset] of imported.media.entries()) {
  const label=`${index+1}/${imported.media.length} ${asset.name}`;
  if(asset.sourceUrl){console.log(`${label}: already uploaded`);continue;}
  if(!asset.sourcePath){console.log(`${label}: no source path in the manifest - relink it in SharedCut.`);continue;}
  let info;try{info=await stat(asset.sourcePath);}catch{console.log(`${label}: source file moved - relink it in SharedCut.`);continue;}
  let state=await call(`/api/media/${asset.id}/upload`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({size:info.size,fingerprint:`${basename(asset.sourcePath)}:${info.size}:${info.mtimeMs}`})});
  if(state.complete){console.log(`${label}: already uploaded`);continue;}
  const handle=await open(asset.sourcePath,'r');
  try {
    for(let offset=state.offset??0;offset<info.size;) {
      const chunk=Buffer.alloc(Math.min(8*1024*1024,info.size-offset));
      await handle.read(chunk,0,chunk.length,offset);
      state=await call(`/api/media/${asset.id}/upload`,{method:'PUT',headers:{'upload-offset':String(offset),'upload-checksum':createHash('sha256').update(chunk).digest('hex')},body:chunk});
      offset=state.offset;
      process.stdout.write(`\r${label}: ${Math.floor(offset/info.size*100)}%   `);
    }
  } finally {await handle.close();}
  console.log(`\r${label}: ${(info.size/1e6).toFixed(1)} MB uploaded   `);
}

console.log('\nImport fidelity report:');for(const warning of imported.warnings)console.log(' - '+warning);
console.log(`\nDone. Open ${server} - the project is on your Projects screen. Proxies finish on the server's preparation queue.`);
