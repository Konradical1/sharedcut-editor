/**
 * Move one project between machines. `data/` is 125 GB and gitignored, so a project travels as a
 * folder you copy by USB or cloud drive, not through git.
 *
 *   node scripts/project-bundle.mjs export "Newspaper" ~/Desktop/newspaper-bundle
 *   node scripts/project-bundle.mjs import ~/Desktop/newspaper-bundle
 *
 * When the other machine already has the footage (a card copied to a laptop), only the edit needs to travel:
 *
 *   node scripts/project-bundle.mjs export "Konrad Trip" ~/Desktop/trip-bundle --no-media
 *   node scripts/project-bundle.mjs import ~/Desktop/trip-bundle --originals ~/Desktop/TRIP
 *
 * Stop the server on BOTH ends first — import writes the JSON workspace row directly, which the
 * next server start picks up, and refuses to run while a server holds the data folder.
 *
 * ponytail: copies whole media directories including generated proxies, so a bundle is bigger than
 * the originals but imports with nothing to re-encode. Delete `prepared/` from the bundle if transfer
 * size matters more than import time — the server's startup upgrade pass rebuilds it.
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { holdDataLock, readWorkspace, writeWorkspaceRow } from './workspace-db.mjs';

const DATA = resolve(process.env.FRAME_LINE_DATA ?? 'data');
// Per-project slices of the workspace state. `operations` is machine-local undo history and
// `renderJobs` are finished exports pointing at files that do not travel; neither is worth carrying.
const BY_PROJECT = ['media', 'clips', 'nodes', 'comments', 'snapshots', 'scripts', 'scriptBlocks', 'shots', 'boardItems'];

const open = () => {
  const file = join(DATA, 'frameline.sqlite');
  if (!existsSync(file)) throw new Error(`No database at ${file}. Set FRAME_LINE_DATA or run from the repo root.`);
  const db = new DatabaseSync(file);
  const row = db.prepare('SELECT revision,state FROM workspace WHERE id=1').get();
  if (!row) throw new Error('The workspace is empty — start the server once before bundling.');
  // The item rows, unless the JSON row is newer. Writing the JSON row back with a higher revision is
  // what makes the next server start import it.
  const { revision, state, fromItems } = readWorkspace(db);
  return { db, revision: Math.max(Number(row.revision), revision), state, fromItems };
};

function exportProject(needle, outDir, { media = true } = {}) {
  const { state } = open();
  const project = state.projects.find(item => item.id === needle)
    ?? state.projects.find(item => item.name.toLowerCase() === needle.toLowerCase())
    ?? (() => { throw new Error(`No project matched ${JSON.stringify(needle)}. Available: ${state.projects.map(item => item.name).join(', ')}`); })();

  const timelines = state.timelines.filter(item => item.projectId === project.id);
  const timelineIds = new Set(timelines.map(item => item.id));
  const slice = Object.fromEntries(BY_PROJECT.map(key => [key, (state[key] ?? []).filter(item => item.projectId === project.id)]));
  // Each original's exact size, so an import with --originals takes the same file and not another take of that name.
  const originals = Object.fromEntries(slice.media.flatMap(asset => { const file = join(DATA, 'media', asset.id, 'original'); return existsSync(file) ? [[asset.id, statSync(file).size]] : []; }));
  const bundle = { version: 1, exportedAt: Date.now(), project, timelines, tracks: state.tracks.filter(item => timelineIds.has(item.timelineId)), ...slice, originals };

  mkdirSync(outDir, { recursive: true });
  if (media) for (const asset of bundle.media) {
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

function importProject(inDir, originalsDir) {
  const bundle = JSON.parse(readFileSync(join(inDir, 'project.json'), 'utf8'));
  if (bundle.version !== 1) throw new Error(`Unsupported bundle version ${bundle.version}.`);
  // Ids become folder names under data/; the server's own id rule keeps a crafted bundle from writing outside them.
  const idIsValid = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id);
  for (const item of [bundle.project, ...BY_PROJECT.flatMap(key => bundle[key] ?? []), ...(bundle.timelines ?? []), ...(bundle.tracks ?? [])]) if (!idIsValid(item?.id)) throw new Error(`The bundle has an invalid id ${JSON.stringify(item?.id)}; refusing to import it.`);
  const { db, revision, state, fromItems } = open();

  // The owner's account id is per-install. Without a remap the project imports invisible: every
  // membership points at a user that does not exist on this machine.
  const owner = db.prepare('SELECT data FROM accounts ORDER BY rowid LIMIT 1').get();
  if (!owner) throw new Error('Create an account on this machine first — sign up in the browser, then import.');
  const ownerId = JSON.parse(String(owner.data)).user.id;

  if (state.projects.some(item => item.id === bundle.project.id)) throw new Error(`Project ${bundle.project.id} already exists here. Delete it in the app first.`);

  // --originals: footage this machine already has, found by name and exact size anywhere in that folder. A hard link
  // takes no space and leaves the folder as it was; the server prepares each relinked file on its next start.
  const local = new Map(), relinked = new Set(), missing = new Map();
  if (originalsDir) for (const path of readdirSync(originalsDir, { recursive: true })) { const key = basename(path).toLowerCase(); local.set(key, [...(local.get(key) ?? []), join(originalsDir, path)]); }
  for (const asset of bundle.media) {
    const from = join(inDir, 'media', asset.id), dir = join(DATA, 'media', asset.id), bytes = bundle.originals?.[asset.id];
    if (existsSync(from)) { cpSync(from, dir, { recursive: true }); continue; }
    const file = (local.get(asset.name.toLowerCase()) ?? []).find(path => { const stat = statSync(path); return stat.isFile() && (bytes === undefined || stat.size === bytes); });
    if (!file) { missing.set(asset.id, asset.name); continue; }
    mkdirSync(dir, { recursive: true }); rmSync(join(dir, 'original'), { force: true });
    try { linkSync(file, join(dir, 'original')); } catch { copyFileSync(file, join(dir, 'original')); }
    relinked.add(asset.id);
  }
  if (missing.size) console.warn(`  ! no file for ${missing.size} asset(s), imported as offline: ${[...missing.values()].join(', ')}`);
  // An asset left 'ready' without its files would only 404; offline says what to do about it.
  const media = bundle.media.map(asset => relinked.has(asset.id) ? { ...asset, status: 'processing', progress: 0, thumbnail: '', error: undefined } : missing.has(asset.id) ? { ...asset, status: 'failed', error: 'The original is not on this computer. Import the file again.' } : asset);
  if (existsSync(join(inDir, 'resolve'))) cpSync(join(inDir, 'resolve'), join(DATA, 'resolve', bundle.project.id), { recursive: true });
  if (existsSync(join(inDir, 'motion-trackers'))) cpSync(join(inDir, 'motion-trackers'), join(DATA, 'motion-trackers'), { recursive: true });

  const next = {
    ...state,
    projects: [...state.projects, { ...bundle.project, members: [{ userId: ownerId, role: 'Owner' }] }],
    timelines: [...state.timelines, ...bundle.timelines],
    tracks: [...state.tracks, ...bundle.tracks],
    // Bundles made before a list existed (the Plan lists) lack it, and the workspace may too.
    ...Object.fromEntries(BY_PROJECT.map(key => [key, [...(state[key] ?? []), ...((key === 'media' ? media : bundle[key]) ?? [])]])),
  };
  writeWorkspaceRow(db, revision + 1, next, { fromItems });

  console.log(`Imported ${JSON.stringify(bundle.project.name)} — ${bundle.media.length} assets, ${bundle.clips.length} clips.`);
  if (originalsDir) console.log(`  ${relinked.size} originals linked from ${originalsDir}; the server prepares them on its next start.`);
  console.log("Start the server and sign in; the project belongs to this machine's first account.");
}

const args = process.argv.slice(2), at = args.indexOf('--originals'), originals = at >= 0 ? args[at + 1] : undefined;
const [mode, target, out] = args.filter((arg, i) => arg !== '--no-media' && (at < 0 || (i !== at && i !== at + 1)));
if (mode === 'export' && target) exportProject(target, resolve(out ?? `${target.toLowerCase().replace(/\W+/g, '-')}-bundle`), { media: !args.includes('--no-media') });
else if (mode === 'import' && target && (at < 0 || originals)) { const lock = holdDataLock(DATA); try { importProject(resolve(target), originals && resolve(originals)); } finally { lock.close(); } }
else {
  console.error('Usage:\n  node scripts/project-bundle.mjs export <project name or id> [outDir] [--no-media]\n  node scripts/project-bundle.mjs import <bundleDir> [--originals <folder with the footage>]\n\nStop the server on both ends first.');
  process.exit(1);
}
