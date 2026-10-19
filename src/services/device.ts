import { useSyncExternalStore } from 'react';

/** A touch screen whose short side is phone-sized. Tablets and narrow desktop windows keep the desktop editor. */
const phone = typeof matchMedia === 'undefined' ? undefined : matchMedia('(pointer: coarse) and (max-width: 500px), (pointer: coarse) and (max-height: 500px)');
const portrait = typeof matchMedia === 'undefined' ? undefined : matchMedia('(orientation: portrait)');
export const isPhone = () => !!phone?.matches;

export type PhoneLayout = 'portrait' | 'landscape' | null;
const layout = (): PhoneLayout => phone?.matches ? portrait?.matches ? 'portrait' : 'landscape' : null;
const subscribe = (changed: () => void) => {
  phone?.addEventListener('change', changed); portrait?.addEventListener('change', changed);
  return () => { phone?.removeEventListener('change', changed); portrait?.removeEventListener('change', changed); };
};
/** Portrait phones get the phone editor, landscape phones a trimmed desktop editor, everything else null. */
export const usePhoneLayout = () => useSyncExternalStore(subscribe, layout, () => null);
