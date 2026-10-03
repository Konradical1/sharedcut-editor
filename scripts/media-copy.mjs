// Isolated copies of live media folders for the check scripts. Hard links, never symlinks: Windows needs elevation for
// those, and a check server's startup migration and cleanup must only ever replace or unlink its own names (a symlinked
// folder let them write into, and delete from, the live media folder).
import { copyFile, constants, cp, link, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const place = async (from, to) => { try { await link(from, to); } catch { await copyFile(from, to, constants.COPYFILE_FICLONE); } };
/** media/<id>: the original and every prepared file, hard-linked (copied across volumes). */
export async function linkMediaFolder(from, to) {
  await mkdir(join(to, 'prepared'), { recursive: true });
  await place(join(from, 'original'), join(to, 'original'));
  for (const file of await readdir(join(from, 'prepared')).catch(() => [])) if (!file.startsWith('.')) await place(join(from, 'prepared', file), join(to, 'prepared', file));
}
/** resolve/<project>: small, so a plain (cloned where the disk can) copy. */
export const copyFolder = (from, to) => cp(from, to, { recursive: true, mode: constants.COPYFILE_FICLONE });
