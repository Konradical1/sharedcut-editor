import test from 'node:test';
import assert from 'node:assert/strict';
import { createSmartMask, smartMaskSignature, validateSmartMask, validateSmartMaskBindings, smartMaskFrame, smartMaskSourceTime, smartMaskRepairAlpha } from './smartMask.ts';
import type { Clip, MediaAsset } from '../state/models.ts';
import { activeSmartMasks, createSmartMaskPreview, fittedSmartMask, SmartMaskPending, smartMaskPreviewContext } from './smartMaskPreview.ts';

const clip={id:'clip',mediaId:'media',start:10,sourceIn:2,duration:2,properties:{speed:100},effects:[]} as unknown as Clip;
const asset={id:'media',kind:'video',fps:24,resolution:'1920 × 1080',duration:10} as MediaAsset;
test('smart mask intent persists separately from revisions; source timing, bounds and bindings are enforced',()=>{
  const doc=createSmartMask(clip,asset,'mask');
  doc.prompts=[{id:'point',time:2,kind:'include',points:[{x:.2,y:.3}],radius:.01}];
  validateSmartMask(doc);
  const signature=smartMaskSignature(doc);
  assert.equal(smartMaskSignature({...doc,name:'Athlete',result:{key:'a'.repeat(64),signature}}),signature);
  assert.equal(smartMaskSignature({...doc,settings:{quality:doc.settings.quality,edgeRadius:doc.settings.edgeRadius,preserveMotionBlur:doc.settings.preserveMotionBlur}}),signature);
  assert.notEqual(smartMaskSignature({...doc,settings:{...doc.settings,preserveMotionBlur:!doc.settings.preserveMotionBlur}}),signature);
  assert.notEqual(smartMaskSignature({...doc,prompts:[{...doc.prompts[0],kind:'exclude'}]}),signature);
  assert.throws(()=>validateSmartMask({...doc,range:{start:3,end:2}}));
  assert.throws(()=>validateSmartMask({...doc,prompts:[{...doc.prompts[0],points:[{x:NaN,y:.2}]}]}));
  assert.throws(()=>validateSmartMask({...doc,repairs:[{...doc.prompts[0],kind:'foreground',radius:0}]}));
  assert.throws(()=>validateSmartMaskBindings({...clip,smartMasks:[doc],effects:[{id:'effect',name:'Smart Mask',enabled:true,amount:100,maskId:'missing'}]},[]));
  const masked={...clip,smartMasks:[doc],effects:[{id:'effect',name:'Smart Mask',enabled:true,amount:100,maskId:'mask'}]};
  validateSmartMaskBindings(masked,[]);
  assert.throws(()=>validateSmartMaskBindings({...masked,mediaId:'other'},[]));
  assert.equal(smartMaskSourceTime(clip,11,asset),3);
  assert.equal(smartMaskSourceTime({...clip,start:20},21,asset),3);
  assert.equal(smartMaskSourceTime({...clip,properties:{speed:50}},11,asset),2.5);
  assert.equal(smartMaskFrame(2.1,{fps:24,duration:10}),50);
  assert.equal(smartMaskFrame(0.074,{fps:24,duration:1},[0,.03,.07,.12]),2);
  assert.equal(smartMaskFrame(0.12,{fps:24,duration:1},[0,.03,.07,.12]),3);
  assert.equal(smartMaskRepairAlpha(.37,'unknown',1),.37);
  assert.equal(smartMaskRepairAlpha(.37,'foreground',1),1);
  assert.equal(smartMaskRepairAlpha(.37,'background',1),0);
  assert.equal(smartMaskRepairAlpha(.5,'foreground',.5),.75);
  assert.deepEqual(Array.from(fittedSmartMask({width:2,height:1,data:new Uint8Array([0,255]),key:'test'},2,3,2,1)),[0,0,0,255,0,0]);
  assert.deepEqual(activeSmartMasks({...masked,effects:[{...masked.effects[0],enabled:false}]},[]),[]);
});

test('preview revalidates cached mattes when clip or source color interpretation changes',async()=>{
  const doc=createSmartMask(clip,asset,'mask');doc.result={key:'b'.repeat(64),signature:smartMaskSignature(doc)};
  const masked={...clip,projectId:'project',smartMasks:[doc],effects:[{id:'effect',name:'Smart Mask',enabled:true,amount:100,maskId:doc.id}]};
  const context=smartMaskPreviewContext(masked,asset);
  assert.equal(smartMaskPreviewContext({...masked,start:100,properties:{...masked.properties,opacity:50}},asset),context);
  for(const field of ['inputProfile','inputGamut','dataLevels','yuvMatrix'])assert.notEqual(smartMaskPreviewContext({...masked,properties:{...masked.properties,[field]:'changed'}},asset),context);
  for(const field of ['inputProfile','inputGamut','colorMatrix'])assert.notEqual(smartMaskPreviewContext(masked,{...asset,[field]:'changed'}),context);
  assert.notEqual(smartMaskPreviewContext({...masked,id:'copy'},asset),context);
  const original=globalThis.fetch,requests:string[]=[];let notified:()=>void=()=>{};
  const preview=createSmartMaskPreview(()=>notified());
  globalThis.fetch=async input=>{requests.push(String(input));return new Response(JSON.stringify({error:'Analyze the current mask before previewing.'}),{status:409,headers:{'content-type':'application/json'}});};
  try{
    for(const current of [masked,{...masked,properties:{...masked.properties,inputProfile:'S-Log3'}}]){
      const ready=new Promise<void>(resolve=>{notified=resolve;});
      assert.throws(()=>preview.read(current,[],2,asset),SmartMaskPending);await ready;
      assert.throws(()=>preview.read(current,[],2,asset),/Analyze the current mask/);
    }
    assert.equal(requests.length,2);assert.notEqual(requests[0],requests[1]);
    const query=new URL(requests[0],'http://localhost').searchParams;assert.equal(query.get('clipId'),masked.id);assert.equal(query.get('context'),context);
  }finally{preview.dispose();globalThis.fetch=original;}
});
