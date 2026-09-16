import {smartMaskSignature,validateSmartMask,type SmartMaskDocument,type SmartMaskRepair} from './smartMask.ts';

/** Published mattes already contain prior repairs. Only an unchanged prefix can be extended safely. */
export function pendingMaskRepairPreview(mask:SmartMaskDocument):SmartMaskRepair[]|null {
  if(!mask.result||mask.result.signature.length>8_000_000)return null;
  try {
    const analyzed={...JSON.parse(mask.result.signature),id:mask.id,name:mask.name};
    validateSmartMask(analyzed);
    if(mask.repairs.length<analyzed.repairs.length||smartMaskSignature({...mask,repairs:mask.repairs.slice(0,analyzed.repairs.length)})!==mask.result.signature)return null;
    const pending=mask.repairs.slice(analyzed.repairs.length);
    // Reset needs the unpainted model alpha, which a published matte cannot reconstruct.
    return pending.some(repair=>repair.kind==='unknown')?null:pending;
  }catch{return null;}
}
