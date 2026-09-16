// Read-only diagnosis of camera/proxy decoding using the real GPU renderer.
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile,symlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const db=new DatabaseSync('data/frameline.sqlite',{readOnly:true});
const state=JSON.parse(db.prepare('select state from workspace where id=1').get().state);db.close();
const out=resolve(process.env.COLOR_CHECK_OUT||'artifacts/qa/color-reference/baseline');await mkdir(out,{recursive:true});
for(const asset of state.media.filter(m=>['C0852.MP4','C0363.MP4'].includes(m.name)))await symlink(resolve('data/media',asset.id,'original'),resolve(out,asset.id+'.mp4')).catch(e=>{if(e.code!=='EEXIST')throw e;});
const server=await createServer({server:{port:0,host:'127.0.0.1'}});await server.listen();
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH});
try {
 const page=await browser.newPage({viewport:{width:1280,height:900}});await page.goto(server.resolvedUrls.local[0]);
 const results=[];
 for(const name of (process.env.COLOR_CHECK_SKY?['C0363.MP4']:process.env.COLOR_CHECK_PRECISION?['C0852.MP4']:['C0852.MP4','C0363.MP4'])){
  const asset=state.media.find(m=>m.name===name),clip=state.clips.find(c=>c.mediaId===asset.id&&c.properties.colorPipeline),nodes=structuredClone(state.nodes.filter(n=>n.clipId===clip.id));
  for(const n of nodes)for(const e of n.effects??[])if(e.type==='cst'&&['shoulder','aces2'].includes(e.toneMapping)){e.toneMapping=process.env.COLOR_CHECK_ACES?'aces2':'shoulder';e.gamutMapping=process.env.COLOR_CHECK_ACES?'none':'compress';}
  for(const file of (process.env.COLOR_CHECK_PRECISION?['precision']:['original','prepared/color-v1.mp4','prepared/proxy.mp4']))for(const time of process.env.COLOR_CHECK_SKY?[.1,2]:name==='C0852.MP4'?[1,4,6]:[6,8,10]){
   const result=await page.evaluate(async({asset,clip,nodes,file,time,outRelative})=>{
    const {createColorPreview,ColorPending}=await import('/src/services/colorPreview.ts');
    const video=document.createElement('video');video.muted=true;video.src=file==='precision'?'/artifacts/qa/color-reference/baseline/precision-h264.mp4':file==='original'?'/'+outRelative+'/'+asset.id+'.mp4':'/data/media/'+asset.id+'/'+file;
    await new Promise((r,j)=>{video.onloadeddata=r;video.onerror=()=>j(Error('Video load '+file));});
    await new Promise(r=>{video.onseeked=r;video.currentTime=time;});
    const input=document.createElement('canvas');input.width=1920;input.height=1080;input.getContext('2d').drawImage(video,0,0,1920,1080);
    const f=new VideoFrame(video),format=f.format,space=f.colorSpace.toJSON();f.close();
    const renderer=createColorPreview();let picture;
    try{
     for(let n=0;n<200;n++){try{picture=renderer.draw(input,clip,file.startsWith('prepared/')?{...asset,colorMatrix:'bt709'}:asset,nodes,video);break;}catch(e){if(!(e instanceof ColorPending))throw e;await new Promise(r=>setTimeout(r,10));}}
     if(!picture)throw Error('Color timed out');
     const gpu=picture.toDataURL();
     const fallback=renderer.draw(input,clip,asset,nodes).toDataURL();
     return {gpu,fallback,format,space,time,file};
    }finally{renderer.dispose();video.removeAttribute('src');video.load();}
   },{asset,clip,nodes,file,time,outRelative:out.slice(process.cwd().length+1)});
   const stem=name.replace('.MP4','')+'-'+file.replaceAll('/','-')+'-'+time;
   for(const type of ['gpu','fallback'])await writeFile(resolve(out,stem+'-'+type+'.png'),Buffer.from(result[type].split(',')[1],'base64'));
   delete result.gpu;delete result.fallback;results.push({name,...result});console.log(name,file,time,result.format,result.space);
  }
 }
 await writeFile(resolve(out,process.env.COLOR_CHECK_SKY?'sky-decode.json':'decode.json'),JSON.stringify(results,null,2));
}finally{await browser.close();await server.close();}
