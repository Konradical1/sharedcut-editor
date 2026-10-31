import { mkdirSync, readdirSync, linkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaAsset } from '../src/state/models.ts';
/** Pin originals and prepared files with independent directory entries; deleting either project is safe. */
export function linkMediaFiles(source: string, target: string) {
  const visit = (from: string, to: string) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(join(from, entry.name), join(to, entry.name));
      else if (entry.isFile() && !/^(replacement|upload)\./.test(entry.name)) linkSync(join(from, entry.name), join(to, entry.name));
    }
  };
  try { visit(source, target); } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
}
export function linkedAsset(source: MediaAsset, id: string, projectId: string): MediaAsset {
  const rewrite = (value: any): any => typeof value === 'string' ? value.replaceAll(`/api/media/${source.id}/`, `/api/media/${id}/`) : Array.isArray(value) ? value.map(rewrite) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,rewrite(v)])) : value;
  return { ...rewrite(source), id, projectId, binId: source.kind === 'audio' ? 'audio' : 'broll' };
}
