// Import a Final Cut Pro project into SharedCut from the bundle sharedcut.com/fcp.sh made on the editor's Mac.
//
//   node scripts/import-fcp.mjs "/media/konradfischer/SD/SharedCut - Edit"
//   node scripts/import-fcp.mjs Edit.fcpxml --media ~/Footage --server https://sharedcut.com
//   node scripts/import-fcp.mjs "<bundle>" --rebuild        re-convert the edit after a re-export (the old edit is kept as a snapshot)
//   node scripts/import-fcp.mjs "<bundle>" --project fcp-…  the project to resume or rebuild, when it is not found by itself
//   node scripts/import-fcp.mjs "<bundle>" --fresh          import a new copy, beside (or after deleting) an earlier one
//
// Run it on the SharedCut host with the drive plugged in, so footage moves over loopback instead of the tunnel.
// Safe to stop and run again: the same Final Cut project maps to the same SharedCut project, finished files are skipped
// and a half-sent one continues from the server's offset. FRAME_LINE_COOKIE skips the sign-in prompt.
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { locateSource, readFcpBundle } from '../server/fcpxml.ts';
import { agentCookie } from './state-patch.mjs';

for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => { console.error('\n' + (error?.message ?? error)); process.exit(1); });

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const toggle = name => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const server = (flag('--server') ?? process.env.FRAME_LINE_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
const folders = []; for (let folder; (folder = flag('--media'));) folders.push(resolve(folder));
const project = flag('--project'), rebuild = toggle('--rebuild'), fresh = toggle('--fresh');
if (!args[0]) throw new Error('Pass the folder sharedcut.com/fcp.sh made (or an .fcpxml file).');
const CHUNK = 8 * 1024 * 1024, ATTEMPTS = 6;

// Hidden terminal input, so the password is never echoed, passed as an argument or stored.
const ask = (label, hidden) => new Promise(done => {
  process.stdout.write(label); const input = process.stdin; input.resume(); input.setEncoding('utf8');
  if (hidden && input.isTTY) input.setRawMode(true);
  let value = '';
  const read = chunk => { for (const character of chunk) {
    if (character === '\u0003') { process.stdout.write('\n'); process.exit(130); }
    if (character === '\n' || character === '\r') { if (hidden && input.isTTY) input.setRawMode(false); input.off('data', read); input.pause(); process.stdout.write('\n'); return done(value.trim()); }
    value = character === '\u007f' || character === '\b' ? value.slice(0, -1) : value + character;
  } };
  input.on('data', read);
});

let cookie = agentCookie();
class Failure extends Error { constructor(status, message) { super(message); this.status = status; } }
const call = async (path, { json, ...init } = {}) => {
  const response = await fetch(server + path, { ...init, headers: { ...(cookie && { cookie }), ...(json && { 'content-type': 'application/json' }), ...init.headers }, ...(json && { body: JSON.stringify(json) }) });
  const text = await response.text();
  const set = response.headers.getSetCookie?.().find(value => value.startsWith('frameline_session='));
  if (set) cookie = set.split(';')[0];
  if (!response.ok) throw new Failure(response.status, `${init.method ?? 'GET'} ${path} → ${response.status}: ${(() => { try { return JSON.parse(text).error; } catch { return text.slice(0, 300); } })()}`);
  return text ? JSON.parse(text) : {};
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const size = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(0)} MB` : `${Math.ceil(bytes / 1e3)} KB`;

const bundle = readFcpBundle(resolve(args[0]));
if (!cookie || await call('/api/auth/me').then(() => false, () => true)) {
  cookie = '';
  await call('/api/auth/login', { method: 'POST', json: { email: await ask(`Email for ${server}: `), password: await ask('Password: ', true) } });
}

// Fonts first: the import resolves title fonts against the library by name.
for (const file of bundle.fonts) {
  const name = basename(file).replace(/\.[^.]+$/, '');
  await call(`/api/fonts?name=${encodeURIComponent(name)}`, { method: 'POST', body: await readFile(file) }).then(() => console.log(`Font ${name} added`), error => console.log(`Font ${name} not added: ${error.message}`));
}
// The server picks the project: the same Final Cut project (re-exported or not) is the same SharedCut project.
// Final Cut's default "Untitled Project" becomes the name the bundle was given.
const query = new URLSearchParams({ ...(bundle.name && { name: bundle.name }), ...(project && { projectId: project }), ...(rebuild && { rebuild: '1' }), ...(fresh && { fresh: '1' }) });
const imported = await call(`/api/fcp/import?${query}`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: bundle.xml });
console.log(`${rebuild ? 'Rebuilt' : 'Imported'} the edit (project ${imported.projectId}).`);
if (imported.warnings.length) { console.log('\nNot carried over from Final Cut:'); for (const warning of imported.warnings) console.log(' - ' + warning); }

// Named and dated as the browser's File is, so a browser or MCP upload of the same file resumes this one.
const fingerprintOf = (file, info) => `${basename(file)}:${info.size}:${Math.trunc(info.mtimeMs)}`;
/** The editor's resumable protocol: POST size + fingerprint, then PUT checksummed chunks at the server's offset. */
async function upload(asset, file, label) {
  const info = await stat(file), fingerprint = fingerprintOf(file, info);
  const begin = () => call(`/api/media/${asset.id}/upload`, { method: 'POST', json: { size: info.size, fingerprint } });
  let state = await begin();
  if (state.complete) return 'already uploaded';
  const handle = await open(file, 'r'), started = Date.now(), from = state.offset ?? 0;
  try {
    for (let offset = from; offset < info.size;) {
      const chunk = Buffer.alloc(Math.min(CHUNK, info.size - offset));
      await handle.read(chunk, 0, chunk.length, offset);
      for (let attempt = 1; ; attempt++) {
        try {
          state = await call(`/api/media/${asset.id}/upload`, { method: 'PUT', headers: { 'upload-offset': String(offset), 'upload-checksum': createHash('sha256').update(chunk).digest('hex') }, body: chunk });
          break;
        } catch (error) {
          // The server's offset moved (an earlier try did land): carry on from what it has.
          if (error.status === 409 && /offset/i.test(error.message)) { state = await begin(); break; }
          if (attempt >= ATTEMPTS || (error.status && error.status < 500 && error.status !== 429)) throw error;
          await sleep(attempt * 2000);
        }
      }
      offset = state.offset ?? offset;
      const rate = (offset - from) / Math.max(1, (Date.now() - started) / 1000);
      process.stdout.write(`\r${label}: ${Math.floor(offset / info.size * 100)}% · ${size(rate)}/s   `);
    }
  } finally { await handle.close(); }
  return `${size(info.size)} uploaded`;
}

const found = folders.length ? (await Promise.all(folders.map(async folder => (await readdir(folder, { recursive: true })).map(name => join(folder, name))))).flat() : [];
const missing = [], failed = [], sources = imported.media.filter(asset => !asset.sourceUrl), located = sources.map(asset => locateSource(asset, bundle.sources, found));
console.log(`\n${imported.media.length} source files · ${imported.media.length - sources.length} already on the server`);
// The plan puts the import on everyone's Projects screen and checks the server has room before a byte moves.
const { maxUploadBytes } = await call('/api/uploads/info');
const planned = (await Promise.all(sources.map(async (asset, i) => located[i] && { id: asset.id, info: await stat(located[i]), file: located[i] }))).filter(f => f && f.info.size >= 1 && f.info.size <= maxUploadBytes);
if (planned.length) await call(`/api/fcp/import/${imported.projectId}`, { method: 'PUT', json: { files: planned.map(f => ({ id: f.id, size: f.info.size, fingerprint: fingerprintOf(f.file, f.info) })) } });
for (const [index, asset] of sources.entries()) {
  const label = `${index + 1}/${sources.length} ${asset.name}`, file = located[index];
  if (!file) { missing.push(asset.name); console.log(`${label}: not found`); continue; }
  // One file the server refuses (too large, empty) must not stop the files after it.
  try { console.log(`\r${label}: ${await upload(asset, file, label)}   `); }
  catch (error) { failed.push(asset.name); console.log(`\r${label}: not uploaded. ${error.message.replace(/^.*→ \d+: /, '')}   `); }
}
const list = names => `${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}`;
if (missing.length) console.log(`\n${missing.length} files were not found: ${list(missing)}. Run again with --media <folder> to upload them.`);
if (failed.length) console.log(`\n${failed.length} files were not uploaded: ${list(failed)}. The reasons are listed above.`);
console.log(`\nDone. Open ${server} — the project is on your Projects screen. Previews finish preparing on the server.`);
