// Sort already-imported footage into media-panel bins, one per source subfolder.
//
//   node scripts/assign-bins.mjs ~/Desktop/Soccer
//
// Media IDs are derived from each file's path relative to the folder, exactly as import-folder.mjs
// derives them, so this matches assets by identity rather than by filename. Safe to re-run, and safe
// to run while preparation is still going: it only PATCHes the bin, never the file or its status.
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative, extname, resolve as resolvePath, sep } from 'node:path';

for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => { console.error('\n' + (error?.message ?? error)); process.exit(1); });

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const server = (flag('--server') ?? process.env.FRAME_LINE_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
if (!args[0]) throw new Error('Pass the folder the footage was imported from.');
const root = resolvePath(args[0]);

const MEDIA = new Set(['.mp4', '.mov', '.m4v', '.mxf', '.avi', '.mkv', '.webm', '.wav', '.mp3', '.aac', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.heic']);
const id = (prefix, value) => `${prefix}-${createHash('sha1').update(value).digest('hex')}`;
const ETX = String.fromCharCode(3), DEL = String.fromCharCode(127);

// Hidden terminal input: the password is never echoed, never an argument, never stored.
const ask = (label, hidden) => new Promise(done => {
  process.stdout.write(label); const input = process.stdin;
  input.resume(); input.setEncoding('utf8');
  if (hidden && input.isTTY) input.setRawMode(true);
  let value = '';
  const read = chunk => { for (let i = 0; i < chunk.length; i++) {
    const c = chunk[i];
    if (c === ETX) { process.stdout.write('\n'); process.exit(130); }
    if (c === '\n' || c === '\r') {
      if (hidden && input.isTTY) input.setRawMode(false);
      input.off('data', read); input.pause();
      let rest = chunk.slice(i + 1); if (c === '\r' && rest.startsWith('\n')) rest = rest.slice(1);
      if (rest) input.unshift(rest);
      process.stdout.write('\n'); return done(value.trim());
    }
    if (c === DEL || c === '\b') { value = value.slice(0, -1); continue; }
    value += c; if (!hidden) process.stdout.write(c);
  } };
  input.on('data', read);
});

let cookie = '';
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

const files = await walk(root);
// Files sitting loose at the top level have no camera folder; leave those where they are.
const wanted = new Map();
for (const file of files) {
  const parts = relative(root, file).split(sep);
  if (parts.length > 1) wanted.set(id('media', relative(root, file)), parts[0]);
}
const counts = {};
for (const bin of wanted.values()) counts[bin] = (counts[bin] ?? 0) + 1;
console.log(`${files.length} files under ${root}`);
console.log('bins: ' + (Object.entries(counts).map(([b, n]) => `${b} (${n})`).join(', ') || 'none'));

await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: await ask(`\nEmail for ${server}: `), password: await ask('Password: ', true) }) });

const view = await call('/api/state');
const known = new Map(view.state.media.map(m => [m.id, m]));
let moved = 0, already = 0, missing = 0;
for (const [mediaId, bin] of wanted) {
  const asset = known.get(mediaId);
  if (!asset) { missing++; continue; }
  if (asset.binId === bin) { already++; continue; }
  await call(`/api/media/${mediaId}`, { method: 'PATCH', body: JSON.stringify({ binId: bin }) });
  moved++;
  process.stdout.write(`\rmoved ${moved}...   `);
}
console.log(`\n\nMoved ${moved} into camera bins. ${already} already correct, ${missing} not imported yet.`);
if (missing) console.log('Re-run once the import finishes to catch the rest.');
