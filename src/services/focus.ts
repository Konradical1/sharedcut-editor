/** Input types you don't type into — they are controls, and the editor keeps its shortcuts over them. */
const NON_TYPING = new Set(['checkbox','radio','range','button','submit','reset','file','image','color','hidden']);
/** True only for a real typing surface: while one is focused every key belongs to it. */
export function typingSurface(el: Element | null) {
  if(!el) return false;
  if(el.tagName==='TEXTAREA') return true;
  if(el.tagName==='INPUT') return !NON_TYPING.has((el as HTMLInputElement).type);
  return !!el.closest('[contenteditable="true"]');
}
/** Which keys the focused control keeps. A slider or a dropdown owns the arrows it was built for;
 *  everything else — Space, Delete, tool letters — is an editor command, whatever has focus. */
export function fieldOwnsKey(target: Element | null, key: string) {
  if(!target) return false;
  if(typingSurface(target)||target.closest('dialog[open]')) return true;
  if(!key.startsWith('Arrow')) return false;
  return target.tagName==='SELECT'||(target.tagName==='INPUT'&&(target as HTMLInputElement).type==='range')||!!target.closest('[role="slider"]');
}
