/**
 * Move one project between machines. `data/` is 125 GB and gitignored, so a project travels as a
 * folder you copy by USB or cloud drive, not through git.
 *
 *   node scripts/project-bundle.mjs export "Newspaper" ~/Desktop/newspaper-bundle
 *   node scripts/project-bundle.mjs import ~/Desktop/newspaper-bundle
 *
 * Stop the server on BOTH ends first — this reads the workspace from SQLite and writes the JSON
 * workspace row directly, and a running server holds the whole state in memory and will overwrite
 * an import when it stops. The next start picks the written row up.
 *
 * ponytail: copies whole media directories including generated proxies, so a bundle is bigger than
 * the originals but imports with nothing to re-encode. Delete `prepared/` from the bundle if transfer
 * size matters more than import time — the server's startup upgrade pass rebuilds it.
 */
import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DATA = resolve(process.env.FRAME_LINE_DATA ?? 'data');
// Per-project slices of the workspace state. `operations` is machine-local undo history and
// `renderJobs` are finished exports pointing at files that do not travel; neither is worth carrying.
const BY_PROJECT = ['media', 'clips', 'nodes', 'comments', 'snapshots'];

// The server keeps the workspace one row per entity in `workspace_items` and rewrites the single JSON
// row only now and then (always on a clean stop), so after a crash the items are newer. They are the
// current copy unless something (this script, an older build) wrote the JSON row since.
const LISTS = ['projects', 'media', 'timelines', 'clips', 'tracks', 'nodes', 'comments', 'operations', 'snapshots', 'renderJobs'];
const current = db => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='workspace_meta'").get()) return undefined;
  const meta = Object.fromEntries(db.prepare('SELECT key,value FROM workspace_meta').all().map(row => [row.key, String(row.value)]));
  if (meta.revision === undefined || meta.legacyWritten === '1') return undefined;
  const state = { ...Object.fromEntries(LISTS.map(key => [key, []])), ...JSON.parse(meta.fields ?? '{}') };
  for (const row of db.prepare('SELECT collection,data FROM workspace_items ORDER BY collection,seq,rowid').all()) (state[row.collection] ??= []).push(JSON.parse(String(row.data)));
  return { revision: Number(meta.revision), state };
};
const open = () => {
  const file = join(DATA, 'frameline.sqlite');
  if (!existsSync(file)) throw new Error(`No database at ${file}. Set FRAME_LINE_DATA or run from the repo root.`);
  const db = new DatabaseSync(file);
  const row = db.prepare('SELECT revision,state FROM workspace WHERE id=1').get();
  if (!row) throw new Error('The workspace is empty — start the server once before bundling.');
  const items = current(db);
  // Writing the JSON row back with a higher revision is what makes the next server start import it.
  return { db, revision: Math.max(Number(row.revision), items?.revision ?? 0), state: items?.state ?? JSON.parse(String(row.state)) };
};

function exportProject(needle, outDir) {
  const { state } = open();
  const project = state.projects.find(item => item.id === needle)
    ?? state.projects.find(item => item.name.toLowerCase() === needle.toLowerCase())
    ?? (() => { throw new Error(`No project matched ${JSON.stringify(needle)}. Available: ${state.projects.map(item => item.name).join(', ')}`); })();

  const timelines = state.timelines.filter(item => item.projectId === project.id);
  const timelineIds = new Set(timelines.map(item => item.id));
  const slice = Object.fromEntries(BY_PROJECT.map(key => [key, state[key].filter(item => item.projectId === project.id)]));
  const bundle = { version: 1, exportedAt: Date.now(), project, timelines, tracks: state.tracks.filter(item => timelineIds.has(item.timelineId)), ...slice };

  mkdirSync(outDir, { recursive: true });
  for (const asset of bundle.media) {
    const from = join(DATA, 'media', asset.id);
    if (!existsSync(from)) { console.warn(`  ! missing media on disk, skipping: ${asset.name}`); continue; }
    cpSync(from, join(outDir, 'media', asset.id), { recursive: true });
  }
  // DaVinci provenance for imported projects; harmless when absent.
  const resolveDir = join(DATA, 'resolve', project.id);
  if (existsSync(resolveDir)) cpSync(resolveDir, join(outDir, 'resolve'), { recursive: true });
  // Motion tracks live beside the workspace as content-addressed sample files, named by the clips (and snapshots) that use them.
  const trackKeys = new Set([...bundle.clips, ...bundle.snapshots.flatMap(snapshot => snapshot.state?.clips ?? [])].flatMap(clip => (clip.motionTrackers ?? []).map(tracker => tracker.result?.key)).filter(key => /^[a-f0-9]{64}$/.test(key ?? '')));
  for (const key of trackKeys) {
    const from = join(DATA, 'motion-trackers', `${key}.json`);
    if (existsSync(from)) cpSync(from, join(outDir, 'motion-trackers', `${key}.json`)); else console.warn(`  ! missing motion track ${key}; that tracker will need tracking again`);
  }

  writeFileSync(join(outDir, 'project.json'), JSON.stringify(bundle, null, 1));
  console.log(`Exported ${JSON.stringify(project.name)} to ${outDir}`);
  console.log(`  ${bundle.media.length} assets, ${bundle.clips.length} clips, ${bundle.timelines.length} timeline(s), ${bundle.tracks.length} tracks`);
}

function importProject(inDir) {
  const bundle = JSON.parse(readFileSync(join(inDir, 'project.json'), 'utf8'));
  if (bundle.version !== 1) throw new Error(`Unsupported bundle version ${bundle.version}.`);
  const { db, revision, state } = open();

  // The owner's account id is per-install. Without a remap the project imports invisible: every
  // membership points at a user that does not exist on this machine.
  const owner = db.prepare('SELECT data FROM accounts ORDER BY rowid LIMIT 1').get();
  if (!owner) throw new Error('Create an account on this machine first — sign up in the browser, then import.');
  const ownerId = JSON.parse(String(owner.data)).user.id;

  if (state.projects.some(item => item.id === bundle.project.id)) throw new Error(`Project ${bundle.project.id} already exists here. Delete it in the app first.`);

  for (const asset of bundle.media) {
    const from = join(inDir, 'media', asset.id);
    if (!existsSync(from)) { console.warn(`  ! bundle is missing files for ${asset.name}, skipping`); continue; }
    cpSync(from, join(DATA, 'media', asset.id), { recursive: true });
  }
  if (existsSync(join(inDir, 'resolve'))) cpSync(join(inDir, 'resolve'), join(DATA, 'resolve', bundle.project.id), { recursive: true });
  if (existsSync(join(inDir, 'motion-trackers'))) cpSync(join(inDir, 'motion-trackers'), join(DATA, 'motion-trackers'), { recursive: true });

  const next = {
    ...state,
    projects: [...state.projects, { ...bundle.project, members: [{ userId: ownerId, role: 'Owner' }] }],
    timelines: [...state.timelines, ...bundle.timelines],
    tracks: [...state.tracks, ...bundle.tracks],
    ...Object.fromEntries(BY_PROJECT.map(key => [key, [...state[key], ...bundle[key]]])),
  };
  db.prepare('UPDATE workspace SET revision=?,state=? WHERE id=1').run(revision + 1, JSON.stringify(next));

  console.log(`Imported ${JSON.stringify(bundle.project.name)} — ${bundle.media.length} assets, ${bundle.clips.length} clips.`);
  console.log("Start the server and sign in; the project belongs to this machine's first account.");
}

const [mode, target, out] = process.argv.slice(2);
if (mode === 'export' && target) exportProject(target, resolve(out ?? `${target.toLowerCase().replace(/\W+/g, '-')}-bundle`));
else if (mode === 'import' && target) importProject(resolve(target));
else {
  console.error('Usage:\n  node scripts/project-bundle.mjs export <project name or id> [outDir]\n  node scripts/project-bundle.mjs import <bundleDir>\n\nStop the server on both ends first.');
  process.exit(1);
}
