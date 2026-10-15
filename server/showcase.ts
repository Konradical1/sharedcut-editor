import { existsSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
/** Only explicitly compiled package files, never a live project or migration bundle. */
export function showcaseFile(dataDir:string,slug:string,name:string) {
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)||!(name==='replay.json'||/^asset-[a-f0-9]{24}\.(jpg|mp4)$/.test(name)))return null;
  const root=join(dataDir,'showcase',slug),candidate=join(root,name);
  if(!existsSync(join(root,'replay.json'))||!existsSync(candidate)||!statSync(candidate).isFile())return null;
  const base=realpathSync(root),file=realpathSync(candidate);return file.startsWith(base+sep)?file:null;
}
