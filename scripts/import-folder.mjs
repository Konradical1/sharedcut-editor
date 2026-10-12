// Import a folder of footage into a running SharedCut project.
//
//   node scripts/import-folder.mjs ~/Desktop/Soccer --project "Girls Soccer" --access class
//   FRAME_LINE_COOKIE='frameline_session=…' node scripts/import-folder.mjs --name "fisch.builds Part 1" <folder>
//
// Defaults to a vertical 1080 × 1920, 30 fps project. FRAME_LINE_COOKIE skips the sign-in prompt, so an
// agent can run it; copy the cookie from a signed-in browser. An existing project with the same name is reused.
//
// Re-running resumes: media IDs are derived from each file's path, so a finished file is skipped
// and a half-sent one continues from the server's offset. Safe to interrupt with Ctrl-C.
//
// Point --server at the LOOPBACK address when the footage is on the machine hosting SharedCut.
// Going out through the public tunnel and back caps the transfer at the household upload link
// (measured: 60s for 200MB through the tunnel against 3.1s over loopback).
//
// From another machine, go through https://sharedcut.com: --parallel files (default 4) go at once,
// since one stream through the tunnel tops out well below the link (Lenovo: ~6-9 MB/s for one, ~18 for four).
import { createHash } from 'node:crypto';
import { readdir, stat, open } from 'node:fs/promises';
import { join, relative, basename, extname, resolve as resolvePath } from 'node:path';
import { agentCookie, patchState } from './state-patch.mjs';

for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => { console.error('\n' + (error?.message ?? error)); process.exit(1); });

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const server = (flag('--server') ?? process.env.FRAME_LINE_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
const projectName = flag('--name') ?? flag('--project') ?? 'Imported footage';
const access = flag('--access') ?? 'private';           // private | people | class
const classRole = flag('--class-role') ?? 'Editor';     // Viewer | Editor
const resolution = flag('--resolution') ?? '1080 × 1920';
const fps = Number(flag('--fps') ?? 30);
const lanes = Math.max(1, Number(flag('--parallel') ?? 4) || 1);
if (!args[0]) throw new Error('Pass the folder holding the footage.');
if (!['private', 'people', 'class'].includes(access)) throw new Error('--access must be private, people, or class.');
const root = resolvePath(args[0]);

const MEDIA = new Set(['.mp4', '.mov', '.m4v', '.mxf', '.avi', '.mkv', '.webm', '.wav', '.mp3', '.aac', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.heic']);
const CHUNK = 8 * 1024 * 1024, ATTEMPTS = 5;
const id = (prefix, value) => `${prefix}-${createHash('sha1').update(value).digest('hex')}`;
const gb = bytes => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

// Hidden terminal input so the password is never echoed, never passed as an argument, and never
// stored — the same prompt scripts/import-resolve.mjs uses.
const ask = (label, hidden) => new Promise(done => {
  process.stdout.write(label); const input = process.stdin;
  input.resume(); input.setEncoding('utf8');
  if (hidden && input.isTTY) input.setRawMode(true);
  let value = '';
  const read = chunk => { for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (c === '') { process.stdout.write('\n'); process.exit(130); }
    if (c === '\n' || c === '\r') {
      if (hidden && input.isTTY) input.setRawMode(false);
      input.off('data', read); input.pause();
      let rest = chunk.slice(i + 1); if (c === '\r' && rest.startsWith('\n')) rest = rest.slice(1);
      if (rest) input.unshift(rest);
      process.stdout.write('\n'); return done(value.trim());
    }
    if (c === '' || c === '\b') { value = value.slice(0, -1); continue; }
    value += c; if (!hidden) process.stdout.write(c);
  } };
  input.on('data', read);
});

let cookie = agentCookie();
async function call(path, init = {}) {
  const response = await fetch(server + path, { ...init, headers: { ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(cookie && { cookie }), ...init.headers } });
  const set = response.headers.getSetCookie?.()[0]; if (set) cookie = set.split(';')[0];
  const text = response.status === 204 ? '' : await response.text();
  if (!response.ok) { const error = new Error(`${path} -> ${response.status} ${text}`); error.status = response.status; throw error; }
  return text ? JSON.parse(text) : null;
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else if (MEDIA.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const files = (await walk(root)).sort();
if (!files.length) throw new Error(`No media files found under ${root}`);
const sizes = new Map(await Promise.all(files.map(async f => [f, (await stat(f)).size])));
const total = files.reduce((sum, f) => sum + sizes.get(f), 0);
// Two cameras can both produce C0001.MP4; qualify a name only when it actually collides.
const counts = new Map(); for (const f of files) counts.set(basename(f), (counts.get(basename(f)) ?? 0) + 1);
const nameFor = f => counts.get(basename(f)) > 1 ? relative(root, f).replaceAll('/', ' · ') : basename(f);

console.log(`${files.length} files, ${gb(total)} from ${root}`);
console.log(`Server ${server}\n`);

if (!cookie) await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: await ask(`Email for ${server}: `), password: await ask('Password: ', true) }) });
const me = (await call('/api/auth/me')).user;
if (!me) throw new Error('Not signed in. Check FRAME_LINE_COOKIE or sign in again.');
console.log(`Signed in as ${me.name || me.email}\n`);

// --- project ------------------------------------------------------------------------------------
// A project made in the browser has a random id; reuse it by name instead of creating a twin.
const existing = (await call('/api/state')).state.projects.find(p => p.name === projectName);
const projectId = existing?.id ?? id('project', `${me.id}:${projectName}`);
let created = false;
await patchState(call, state => {
  const project = state.projects.find(p => p.id === projectId);
  if (project) {
    // Room for a ~60 s reel even when the project was made with an empty timeline.
    const short = state.timelines.filter(t => t.projectId === projectId && t.duration < 60);
    return short.length ? { timelines: { upsert: short.map(t => ({ ...t, duration: 60 })), remove: [] } } : null;
  }
  created = true;
  const timelineId = id('timeline', projectId);
  return {
    projects: { upsert: [{ id: projectId, name: projectName, description: '', thumbnail: '', modifiedAt: Date.now(), duration: 0, resolution, fps, shared: false, status: 'In progress', members: [] }], remove: [] },
    timelines: { upsert: [{ id: timelineId, projectId, name: projectName, duration: 60 }], remove: [] },
    tracks: { upsert: [['v2', 'B-roll', 'video', 2], ['v1', 'Main picture', 'video', 1], ['a1', 'Dialogue', 'audio', 1], ['a2', 'Music', 'audio', 2]]
      .map(([slug, name, kind, number]) => ({ id: id('track', `${timelineId}:${slug}`), timelineId, name, kind, number, muted: false, solo: false, locked: false, hidden: false, gain: kind === 'audio' && number !== 1 ? -12 : 0, pan: 0 })), remove: [] },
  };
});
console.log(created ? `Created project "${projectName}" ${resolution} ${fps} fps (you are Owner)` : `Project "${projectName}" already exists — resuming`);

if (access !== 'private') {
  await call(`/api/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ access, ...(access === 'class' ? { classRole } : {}) }) });
  console.log(access === 'class' ? `Shared with the whole class as ${classRole}` : 'Shared with selected people');
}
console.log('');

// --- upload -------------------------------------------------------------------------------------
const started = Date.now();
let sent = 0, done = 0, skipped = 0;
const rate = () => { const s = (Date.now() - started) / 1000; return s > 0 ? `${(sent / 1024 ** 2 / s).toFixed(0)} MB/s` : '-'; };
const overall = () => `${gb(sent)}/${gb(total)} overall  ${rate()}`;
const finished = (name, what) => process.stdout.write(`\r[${String(++done).padStart(3)}/${files.length}] ${name} - ${what}  ${overall()}          \n`);

async function upload(file) {
  const size = sizes.get(file), name = nameFor(file), mediaId = id('media', `${projectId}:${relative(root, file)}`);   // per project: one folder can feed two reels
  const { mtimeMs } = await stat(file);
  const fingerprint = `${name}:${size}:${Math.floor(mtimeMs)}`;

  for (let attempt = 1; ; attempt++) {
    try { await call(`/api/media?${new URLSearchParams({ projectId, id: mediaId, name, placeholder: '1' })}`, { method: 'POST' }); break; }
    catch (error) {
      if (error.status === 409) break;   // already created by an earlier run
      if (error.status !== 429 || attempt >= ATTEMPTS * 2) throw error;
      await new Promise(r => setTimeout(r, Math.min(15000, 500 * 2 ** attempt)));
    }
  }

  const state = await call(`/api/media/${mediaId}/upload`, { method: 'POST', body: JSON.stringify({ size, fingerprint }) });
  if (state.complete) { skipped++; sent += size; finished(name, 'already uploaded'); return; }

  const handle = await open(file, 'r');
  try {
    let offset = state.offset || 0, stalled = 0;
    const buffer = Buffer.allocUnsafe(CHUNK);
    sent += offset;
    while (offset < size) {
      const before = offset;
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - offset), offset);
      const chunk = buffer.subarray(0, bytesRead);
      const digest = createHash('sha256').update(chunk).digest('hex');
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try { ({ offset } = await call(`/api/media/${mediaId}/upload`, { method: 'PUT', headers: { 'Upload-Offset': String(offset), 'Upload-Checksum': digest }, body: chunk })); break; }
        catch (error) {
          // 409 means the server moved our offset; 429/5xx are worth another try. Anything else is real.
          const recoverable = !error.status || error.status === 409 || error.status === 429 || error.status >= 500;
          if (attempt === ATTEMPTS || !recoverable) throw error;
          await new Promise(r => setTimeout(r, Math.min(8000, 250 * 2 ** attempt)));
          const current = await call(`/api/media/${mediaId}/upload`).catch(() => null);
          if (current?.complete) { offset = size; break; }
          if (current && current.offset !== offset) { offset = current.offset; break; }
        }
      }
      if (offset === before && ++stalled >= ATTEMPTS) throw new Error(`${name}: upload stalled; the server stopped accepting data.`);
      if (offset !== before) { sent += offset - before; stalled = 0; }
      process.stdout.write(`\r${done}/${files.length} files  ${overall()}   `);
    }
  } finally { await handle.close(); }
  finished(name, 'done');
}

// Largest first, so one giant clip never runs alone at the end. Chunks within a file stay in order.
const queue = [...files].sort((a, b) => sizes.get(b) - sizes.get(a));
await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, async () => { for (let file; (file = queue.shift());) await upload(file); }));

// A server restart mid-preparation leaves assets reading "Processing was interrupted". Their
// originals are already on disk, so a retry resumes from those instead of re-uploading anything.
const after = await call('/api/state');
const failed = after.state.media.filter(m => m.projectId === projectId && m.status === 'failed');
if (failed.length) {
  console.log(`\nRetrying ${failed.length} interrupted preparation(s)...`);
  for (const m of failed) await call(`/api/media/${m.id}/retry`, { method: 'POST' }).catch(e => console.log(`  ${m.name}: ${e.message}`));
  console.log('Queued for reprocessing.');
}

const minutes = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\nUploaded ${files.length - skipped} files (${skipped} already present) in ${minutes} min.`);
console.log('The server is still preparing proxies in the background - watch the media panel for "ready".');
