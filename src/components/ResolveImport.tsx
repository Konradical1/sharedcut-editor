import { useRef, useState } from 'react';
import { createId } from '../services';
import { useEditorStore } from '../state/store';
import { api, connection } from '../services/api';
import { Button, Modal } from './ui';
import type { MediaAsset } from '../state/models';
import { uploadSource } from '../services/upload';

export default function ResolveImport({onClose,onOpen}:{onClose:()=>void;onOpen:(id:string)=>void}) {
  const [files,setFiles]=useState<File[]>([]),[manifest,setManifest]=useState<any>(),[message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState<{projectId:string;warnings:string[];media:MediaAsset[];files:string[]}>();
  const projectId=useRef(createId('resolve')),resumeKey=useRef('');
  const [fresh,setFresh]=useState(false);
  const addFiles=(list:FileList|null)=>{if(!list)return;const added=Array.from(list);setFiles(previous=>[...previous,...added.filter(f=>!previous.some(p=>p.name===f.name&&p.webkitRelativePath===f.webkitRelativePath&&p.size===f.size&&p.lastModified===f.lastModified))]);const manifests=added.filter(f=>f.name==='project.frameline.json');if(manifests.length===1)void load(manifests[0]);else if(manifests.length>1)setError('Select one bridge export folder at a time.');};
  const load=async(file?:File)=>{
    if(!file)return;setError('');
    if(file.name.endsWith('.drp')){setError('Open the .drp in Resolve, then export a SharedCut bundle using the bridge. A .drp contains project data, but no source footage.');return;}
    try{if(!crypto.subtle)throw new Error('Resolve bundle imports require HTTPS or localhost for verified uploads.');const text=await file.text(),m=JSON.parse(text);if(m.format!=='frameline-resolve')throw new Error('Select project.frameline.json from the bridge export.');const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');const key='frameline-resolve-'+useEditorStore.getState().currentUserId+'-'+hash;resumeKey.current=key;projectId.current=localStorage.getItem(key)||createId('resolve');setFresh(false);setManifest(m);setResult(undefined);}catch(e){setError((e as Error).message);}
  };
  const run=async()=>{
    setBusy(true);setError('');
    try {
      await connection.flush();
      const otios=await Promise.all(manifest.timelines.map(async (_:unknown,i:number)=>{const file=files.find(f=>f.name===`timeline-${i+1}.otio`);if(!file)throw new Error(`Add the bridge folder containing timeline-${i+1}.otio.`);return JSON.parse(await file.text());}));
      if(fresh){projectId.current=createId('resolve');setFresh(false);}
      localStorage.setItem(resumeKey.current,projectId.current);
      const imported=await api('/resolve/import',{method:'POST',body:JSON.stringify({projectId:projectId.current,manifest,otios})});setResult(imported);
      const missing:string[]=[];
      for(const name of imported.files as string[]) {
        if(name==='project.frameline.json')continue;
        const file=files.find(f=>f.name===name);
        if(!file){missing.push(name);continue;}
        setMessage(`Saving ${name}…`);await api(`/projects/${imported.projectId}/resolve/${name}`,{method:'PUT',body:file});
      }
      for(const asset of imported.media as MediaAsset[]) {
        if(asset.sourceUrl)continue;
        const matches=files.filter(f=>f.name===asset.name);
        if(matches.length!==1){missing.push(`${asset.name}${matches.length?' (ambiguous: select only its source folder)':''}`);continue;}
        await uploadSource(asset.id,matches[0],percent=>setMessage(`${asset.name} · ${percent}% uploaded`));
      }
      await connection.refresh();setMessage(missing.length?`Timeline saved. ${missing.length} files still need relinking: ${missing.slice(0,8).join(', ')}${missing.length>8?'…':''}`:'Timeline and originals uploaded. Proxies are processing on the server.');
    }catch(e){setError((e as Error).message+' Select the same bundle to resume safely.');}finally{setBusy(false);}
  };
  return <Modal title="Import from DaVinci Resolve" onClose={busy?()=>{}:onClose} wide><div style={{display:'grid',gap:16,padding:24}}>
    <ol style={{paddingLeft:18,lineHeight:1.7,color:'var(--text-secondary)'}}><li>Open your .drp in Resolve and run the <a href="/api/resolve/bridge" download>SharedCut bridge</a>. The script exports the current project; it does not modify your grades.</li><li>Select the bridge export folder below. Its project is detected automatically.</li><li>Add each original media folder. Uploads resume from their last verified chunk.</li></ol>
    <details><summary>Select a manifest separately</summary><label className="form-field"><span>Resolve manifest</span><input disabled={busy} aria-label="Resolve manifest" type="file" accept=".json,.drp" onChange={e=>void load(e.target.files?.[0])}/></label></details>
    <label className="form-field"><span>Bundle and media folders</span><input disabled={busy} aria-label="Resolve bundle and media folders" type="file" multiple {...{webkitdirectory:''}} onChange={e=>addFiles(e.target.files)}/></label>
    <label className="form-field"><span>Additional files, such as music</span><input disabled={busy} aria-label="Additional Resolve files" type="file" multiple onChange={e=>addFiles(e.target.files)}/></label>
    <span className="muted">{manifest?.name||'No project selected'} · {files.length} files selected</span>
    {manifest&&!result&&<label><input type="checkbox" disabled={busy} checked={fresh} onChange={e=>setFresh(e.target.checked)}/> Import as a new project for a clean slate <small>(keeps the previous edit)</small></label>}
    {message&&<p role="status">{message}</p>}{error&&<p role="alert" style={{color:'#ec9b91'}}>{error}</p>}
    {result&&<details><summary>Import fidelity report</summary><ul>{result.warnings.map(w=><li key={w}>{w}</li>)}</ul><p>Imported projects start private. Share the project when its media is ready.</p></details>}
    <div className="row" style={{justifyContent:'flex-end',gap:8}}><Button variant="ghost" disabled={busy} onClick={onClose}>Close</Button>{result&&<Button disabled={busy} onClick={()=>onOpen(result.projectId)}>Open project</Button>}<Button variant="primary" disabled={busy||!manifest} onClick={()=>void run()}>{busy?'Importing…':result?'Resume import':'Import project'}</Button></div>
  </div></Modal>;
}
