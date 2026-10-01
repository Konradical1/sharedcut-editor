/**
 * Run this before starting a server build older than the item tables (61b8d6b and earlier).
 *
 *   node scripts/sync-legacy-row.mjs            (FRAME_LINE_DATA picks another data folder)
 *
 * Those builds read only the single JSON workspace row. The server writes that row on a clean stop,
 * but production stops are hard kills (windows-host.ps1 restart), after which the row can miss the
 * last saves; an older build would start from it and, once saved, its row replaces the newer ones.
 * This copies the item rows into it. It refuses to run beside a server, and leaves a row that is
 * already current, or newer (written by an older build or an import), alone.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { holdDataLock, readWorkspace, writeWorkspaceRow } from './workspace-db.mjs';

const data = resolve(process.env.FRAME_LINE_DATA ?? 'data'), file = join(data, 'frameline.sqlite');
if (!existsSync(file)) throw new Error(`No database at ${file}. Set FRAME_LINE_DATA or run from the repo root.`);
const lock = holdDataLock(data), db = new DatabaseSync(file);
try {
  const workspace = readWorkspace(db), row = db.prepare('SELECT revision FROM workspace WHERE id=1').get();
  const copied = db.prepare("SELECT value FROM workspace_meta WHERE key='legacyRevision'").get();
  if (!workspace?.fromItems) console.log('The workspace row is already the newest copy; nothing to do.');
  else if (row && Number(copied?.value) === workspace.revision) console.log(`The workspace row is current (revision ${workspace.revision}).`);
  else { writeWorkspaceRow(db, workspace.revision, workspace.state, { copy: true }); console.log(`Copied revision ${workspace.revision} into the workspace row. An older build can start now.`); }
} finally { db.close(); lock.close(); }
