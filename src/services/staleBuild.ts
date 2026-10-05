// A tab opened before a deploy still asks for the hashed files that deploy replaced, so a panel it has not opened yet
// fails to load. Vite reports that as 'vite:preloadError'; React.lazy rejects with the browser's own wording.
const CHUNK_FAILURE = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading chunk [\w-]+ failed|ChunkLoadError/i;

export const isChunkLoadError = (error: unknown) => CHUNK_FAILURE.test(error instanceof Error ? `${error.name} ${error.message}` : '');

let stale = false;
const listeners = new Set<() => void>();
/** Remember that a newer build exists. Never reloads: the person decides when. */
export function markStaleBuild() {
  if (stale) return;
  stale = true;
  for (const listener of listeners) listener();
}
export const staleBuild = {
  get: () => stale,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
/** The event is left alone (not prevented), so the failing import still rejects and its own panel can say so. */
export function watchPreloadErrors(target: EventTarget, onStale: () => void = markStaleBuild) {
  target.addEventListener('vite:preloadError', () => onStale());
}
