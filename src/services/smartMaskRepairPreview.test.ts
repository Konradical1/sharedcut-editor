import assert from 'node:assert/strict';
import {test} from 'node:test';
import {smartMaskSignature,type SmartMaskDocument} from './smartMask.ts';
import {pendingMaskRepairPreview} from './smartMaskRepairPreview.ts';

test('local repair preview reuses only unchanged analyzed intent and append-only paint',()=>{
  const mask:SmartMaskDocument={version:1,id:'mask',name:'Subject',source:{mediaId:'media',fps:24,width:640,height:360,duration:2},range:{start:0,end:2},prompts:[{id:'guide',kind:'include',time:0,radius:.01,points:[{x:.5,y:.5}]}],repairs:[],settings:{quality:'preview',preserveMotionBlur:false,edgeRadius:16}};
  assert.equal(pendingMaskRepairPreview(mask),null);
  mask.result={key:'a'.repeat(64),signature:smartMaskSignature(mask)};
  const repair={id:'paint',time:0,kind:'background' as const,radius:.01,points:[{x:.7,y:.4}]};
  mask.repairs.push(repair);
  assert.deepEqual(pendingMaskRepairPreview(mask),[repair]);
  assert.equal(pendingMaskRepairPreview({...mask,prompts:[]}),null);
  assert.equal(pendingMaskRepairPreview({...mask,range:{start:.1,end:2}}),null);
  assert.equal(pendingMaskRepairPreview({...mask,repairs:[{...repair,kind:'unknown'}]}),null);
  mask.result.signature=smartMaskSignature(mask);
  assert.deepEqual(pendingMaskRepairPreview(mask),[]);
  assert.equal(pendingMaskRepairPreview({...mask,repairs:[]}),null);
  assert.equal(pendingMaskRepairPreview({...mask,result:{...mask.result,signature:'invalid'}}),null);
});
