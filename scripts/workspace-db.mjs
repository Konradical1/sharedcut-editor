// Reading and writing the workspace from scripts, in plain JavaScript so they run on any Node with
// node:sqlite. Mirrors server/workspaceStore.ts: the server keeps the workspace one row per entity in
// `workspace_items` and rewrites the single JSON row older builds read only now and then (always on a
// clean stop), so after a hard kill the items are newer. They are the current copy unless something
// (an import, an older build) wrote the JSON row since.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const LISTS = ['projects', 'media', 'timelines', 'clips', 'tracks', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs', 'scripts', 'scriptBlocks', 'shots', 'boardItems'];
const metaOf = db => db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_meta'").get()
  ? Object.fromEntries(db.prepare('SELECT key,value FROM workspace_meta').all().map(row => [row.key, String(row.value)])) : {};

/** The workspace as last saved, and whether it came from the item rows. Undefined for an empty database. */
export function readWorkspace(db) {
  const meta = metaOf(db);
  if (meta.revision !== undefined && meta.legacyWritten !== '1') {
    const state = { ...Object.fromEntries(LISTS.map(key => [key, []])), ...JSON.parse(meta.fields ?? '{}') };
    for (const row of db.prepare('SELECT collection,data FROM workspace_items ORDER BY collection,seq,rowid').all()) (state[row.collection] ??= []).push(JSON.parse(String(row.data)));
    return { revision: Number(meta.revision), state, fromItems: true };
  }
  const row = db.prepare('SELECT revision,state FROM workspace WHERE id=1').get();
  return row && { revision: Number(row.revision), state: JSON.parse(String(row.state)), fromItems: false };
}

/**
 * Writes the JSON row. A `copy` holds exactly the item rows, so the server keeps loading those. Anything
 * else is new data the server imports on its next start; `fromItems` says it was built on the rows, so
 * the server knows the import drops none of their saves.
 */
export function writeWorkspaceRow(db, revision, state, { copy = false, fromItems = false } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO workspace(id,revision,state) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,state=excluded.state').run(revision, JSON.stringify(state));
    const meta = metaOf(db), set = db.prepare('INSERT INTO workspace_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    if (meta.revision !== undefined && (copy || fromItems)) set.run('legacyRevision', meta.revision);
    if (meta.revision !== undefined && copy) set.run('legacyWritten', '0');
    db.exec('COMMIT');
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}

/** The lock a running server holds (holdDataLock in server/workspaceStore.ts): taking it refuses to write beside one. */
export function holdDataLock(dataDir) {
  if (!existsSync(dataDir)) throw new Error(`No data folder at ${dataDir}. Set FRAME_LINE_DATA or run from the repo root.`);
  const lock = new DatabaseSync(join(dataDir, 'frameline.lock'), { timeout: 2000 });
  try { lock.exec('PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS holder(pid INTEGER NOT NULL); DELETE FROM holder'); lock.prepare('INSERT INTO holder(pid) VALUES(?)').run(process.pid); }
  catch (error) { lock.close(); throw new Error(`Another SharedCut server or script is using ${dataDir}. Stop it first.`, { cause: error }); }
  return lock;
}
