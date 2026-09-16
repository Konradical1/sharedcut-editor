import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { GlobalFonts } from '@napi-rs/canvas';

export function fontLibrary(db: DatabaseSync) {
  db.exec('CREATE TABLE IF NOT EXISTS fonts(id TEXT PRIMARY KEY,name TEXT NOT NULL,data BLOB NOT NULL,uploader TEXT NOT NULL,createdAt INTEGER NOT NULL)');
  for (const row of db.prepare('SELECT id,data FROM fonts').all() as { id: string; data: Uint8Array }[]) GlobalFonts.register(Buffer.from(row.data), row.id);
  const describe = (row: {id: string; name: string; createdAt: number}) => ({ ...row, family: row.id, url: `/api/fonts/${row.id}` });
  return {
    list: () => (db.prepare('SELECT id,name,createdAt FROM fonts ORDER BY name COLLATE NOCASE').all() as {id: string; name: string; createdAt: number}[]).map(describe),
    get: (id: string) => db.prepare('SELECT data FROM fonts WHERE id=?').get(id) as { data: Uint8Array } | undefined,
    add(data: Buffer, name: string, uploader: string) {
      if (data.length < 12 || data.length > 15 * 1024 * 1024 || !['00010000', '4f54544f', '774f4646', '774f4632', '74746366'].includes(data.subarray(0, 4).toString('hex'))) throw new Error('Choose a valid TTF, OTF, TTC, WOFF, or WOFF2 font under 15 MB.');
      const id = `FL-${createHash('sha256').update(data).digest('hex').slice(0, 32)}`;
      if (!GlobalFonts.has(id) && !GlobalFonts.register(data, id)) throw new Error('This font could not be read. Try a TTF or OTF file.');
      db.prepare('INSERT OR IGNORE INTO fonts(id,name,data,uploader,createdAt) VALUES(?,?,?,?,?)').run(id, name, data, uploader, Date.now());
      return this.list().find(font => font.id === id)!;
    },
  };
}
