// Imported first by every MCP entry point, before the editor store loads.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

// A few browser-side modules (motionTrackerClient.ts, smartMaskClient.ts, sourceFocus.ts) import siblings without the
// .ts extension, which Vite resolves and Node does not: try the .ts file first for extensionless imports inside src/.
const SRC = new URL('../src/', import.meta.url).href;
registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('.') && !/\.\w+$/.test(spec) && context.parentURL?.startsWith(SRC)) { try { return next(`${spec}.ts`, context); } catch { /* not a .ts module */ } }
    return next(spec, context);
  },
});

// Node 25+ warns on stderr the first time anything touches its built-in localStorage. The store only keeps viewer
// conveniences there (In/Out per timeline, recent projects), so a per-process memory store stands in.
const memory = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => void memory.set(key, String(value)),
    removeItem: (key: string) => void memory.delete(key),
    clear: () => memory.clear(),
    key: (index: number) => [...memory.keys()][index] ?? null,
    get length() { return memory.size; },
  },
});

/** An app source file by repo path (help derives catalogs from them). The standalone bundle carries the few it needs. */
export function appFile(path: string): string {
  const packed = (globalThis as { __SHAREDCUT_SOURCES__?: Record<string, string> }).__SHAREDCUT_SOURCES__;
  return packed?.[path] ?? readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
