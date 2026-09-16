import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { probeMedia } from './media.ts';

/**
 * The overlay pack: real light-leak and film-burn clips shared by every project on this
 * installation, the same way shared fonts are. They live as files beside the database rather
 * than inside it — they are tens of megabytes of video, and project saves are capped at 20 MiB.
 *
 * `scripts/extract-transitions.mjs` writes the initial pack by cutting supplied compilation
 * reels at their black frames; `add` accepts further overlays uploaded through the editor.
 */
export interface LeakEntry {
  id: string;
  name: string;
  file: string;
  duration: number;
  fps: number;
  hasAudio: boolean;
  poster?: string;
  source?: string;
  meanLuma?: number;
  peakLuma?: number;
  /** Where the burn is brightest, 0..1 through the clip; the cut is placed here. */
  peakAt?: number;
  addedBy?: string;
  addedAt?: number;
}

const MANIFEST = 'manifest.json';
const MAX_LEAKS = 500;
const idPattern = /^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/;

export function transitionLibrary(dataDir: string) {
  const dir = join(dataDir, 'transitions');
  const manifestPath = join(dir, MANIFEST);

  const read = (): LeakEntry[] => {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.leaks)) return [];
      // A hand-edited manifest must not be able to point at files outside the pack directory.
      return parsed.leaks.filter((leak: LeakEntry) => leak && idPattern.test(String(leak.id)) && leak.file === `${leak.id}.mp4` && existsSync(join(dir, leak.file)));
    } catch { return []; }
  };
  const write = (leaks: LeakEntry[]) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(manifestPath, JSON.stringify({ version: 1, updatedAt: Date.now(), leaks }, null, 2), { mode: 0o600 });
  };

  return {
    list: () => read().map(leak => ({ ...leak, url: `/api/transitions/${leak.id}.mp4`, ...(existsSync(join(dir, `${leak.id}.jpg`)) ? { posterUrl: `/api/transitions/${leak.id}.jpg` } : {}) })),
    /** Resolve an id to a path inside the pack, or null. Never joins caller-supplied text. */
    path(id: string, kind: 'mp4' | 'jpg' = 'mp4') {
      if (!idPattern.test(id)) return null;
      const leak = read().find(entry => entry.id === id);
      if (!leak) return null;
      const file = kind === 'jpg' ? join(dir, `${id}.jpg`) : join(dir, leak.file);
      return existsSync(file) ? file : null;
    },
    async add(data: Uint8Array, name: string, userId: string) {
      const leaks = read();
      if (leaks.length >= MAX_LEAKS) throw new Error('The overlay library is full.');
      const clean = name.trim().slice(0, 80);
      if (!clean) throw new Error('Name the overlay before uploading it.');
      const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'overlay';
      let id = base;
      for (let n = 2; leaks.some(leak => leak.id === id); n++) id = `${base}-${n}`;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${id}.mp4`);
      writeFileSync(file, data, { mode: 0o600 });
      try {
        const probed = await probeMedia(file);
        if (!probed.duration || probed.duration > 30) throw new Error('An overlay must be shorter than 30 seconds.');
        const entry: LeakEntry = { id, name: clean, file: `${id}.mp4`, duration: probed.duration, fps: Number(probed.fps) || 24, hasAudio: !!probed.hasAudio, addedBy: userId, addedAt: Date.now() };
        write([...leaks, entry]);
        return { ...entry, url: `/api/transitions/${id}.mp4` };
      } catch (error) {
        rmSync(file, { force: true });
        throw error instanceof Error ? error : new Error('That overlay could not be read.');
      }
    },
    remove(id: string) {
      const leaks = read();
      const leak = leaks.find(entry => entry.id === id);
      if (!leak) return false;
      rmSync(join(dir, leak.file), { force: true });
      rmSync(join(dir, `${id}.jpg`), { force: true });
      rmSync(join(dir, 'sheets', `${id}.png`), { force: true });
      write(leaks.filter(entry => entry.id !== id));
      return true;
    },
  };
}
