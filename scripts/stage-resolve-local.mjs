// Local migration preparation. Writes a new staging folder; never changes the running database.
// node scripts/stage-resolve-local.mjs BRIDGE_FOLDER STAGING_FOLDER OWNER_ID
import {readFile,writeFile,mkdir,copyFile,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {importResolve} from '../server/resolve.ts';
import {prepareMedia} from '../server/media.ts';
const [bundleArg,stageArg,owner]=process.argv.slice(2);if(!bundleArg||!stageArg||!owner)throw new Error('Pass bridge folder, new staging folder, and existing owner ID.');
const bundle=resolve(bundleArg),stage=resolve(stageArg),manifest=JSON.parse(await readFile(join(bundle,'project.frameline.json'),'utf8'));
const otios=await Promise.all(manifest.timelines.map((_,i)=>readFile(join(bundle,`timeline-${i+1}.otio`),'utf8').then(JSON.parse)));
const imported=importResolve(manifest,'resolve-'+randomUUID(),owner,otios);
await mkdir(stage);await mkdir(join(stage,'media'));await mkdir(join(stage,'resolve',imported.project.id),{recursive:true});
for(const file of imported.files)await copyFile(join(bundle,file),join(stage,'resolve',imported.project.id,file));
for(const [i,asset] of imported.media.entries()) {
  const dir=join(stage,'media',asset.id);await mkdir(dir);await copyFile(asset.sourcePath,join(dir,'original'));
  const metadata=await prepareMedia({inputPath:join(dir,'original'),outputDir:join(dir,'prepared'),baseUrl:`/api/media/${asset.id}/files`});
  const {size,...rest}=metadata;Object.assign(asset,rest,{size:`${(size/1e6).toFixed(1)} MB`,status:'ready',progress:100,sourceUrl:`/api/media/${asset.id}/original`});
  console.log(`${i+1}/${imported.media.length} ${asset.name}: ${asset.inputProfile||'untagged'} ${asset.inputGamut||''}`);
}
imported.project.thumbnail=imported.clips.find(c=>c.properties.resolveReferenceUrl)?.properties.resolveReferenceUrl||'';
await writeFile(join(stage,'import.json'),JSON.stringify(imported,null,2));console.log('Staged '+imported.project.id);
