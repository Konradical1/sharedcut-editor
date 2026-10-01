import { useEffect } from 'react';
import { useFootageVersion } from '../services/footageCache';
import { useEditorStore } from '../state/store';

// The footage cache notifies up to four times a second. Clip badges, the render bar and the viewer's footage panel follow
// it through this one relay instead: while playing at most once a second, and all in the same frame. Every update is a
// layout and a re-layerization of the whole timeline (~20 ms on a fast laptop, ~140 ms at 4x CPU slowdown), so separate
// panels each updating several times a second cost more than playing the picture. Paused, updates pass straight through.
const RELAY_PLAYING_MS = 1000, listeners = new Set<() => void>();
let relayed = 0, relayAt = 0, timer: ReturnType<typeof setTimeout> | undefined;
const relay = () => { timer = undefined; relayAt = performance.now(); relayed++; listeners.forEach(listener => listener()); };
export const subscribeFootage = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const footageRelayed = () => relayed;
/** Forwards cache changes to the relay; mount it beside anything that shows relayed footage (more than one is harmless). */
export function FootageRelay() {
  const version = useFootageVersion();
  useEffect(() => {
    if (timer !== undefined) return;
    const wait = useEditorStore.getState().playing ? RELAY_PLAYING_MS - (performance.now() - relayAt) : 0;
    if (wait > 0) timer = setTimeout(relay, wait); else relay();
  }, [version]);
  return null;
}
