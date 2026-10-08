// Import a Final Cut Pro project into SharedCut from the bundle sharedcut.com/fcp.sh made on the editor's Mac.
//
//   node scripts/import-fcp.mjs "/media/konradfischer/SD/SharedCut - Edit"
//   node scripts/import-fcp.mjs Edit.fcpxml --media ~/Footage --server https://sharedcut.com
//   node scripts/import-fcp.mjs "<bundle>" --rebuild        re-convert an imported project's edit (the old edit is kept as a snapshot)
//
// Run it on the SharedCut host with the drive plugged in, so footage moves over loopback instead of the tunnel.
// Safe to stop and run again: the same XML maps to the same project, finished files are skipped and a half-sent
// one continues from the server's offset. FRAME_LINE_COOKIE skips the sign-in prompt.
import { createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fcpProjectId, locateSource, readFcpBundle } from '../server/fcpxml.ts';
import { agentCookie } from './state-patch.mjs';

for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => { console.error('\n' + (error?.message ?? error)); process.exit(1); });

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const server = (flag('--server') ?? process.env.FRAME_LINE_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, '');
const folders = []; for (let folder; (folder = flag('--media'));) folders.push(resolve(folder));
const rebuild = args.includes('--rebuild'); if (rebuild) args.splice(args.indexOf('--rebuild'), 1);
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
const projectId = fcpProjectId(bundle.xml);
const imported = await call(`/api/fcp/import?projectId=${projectId}${rebuild ? '&rebuild=1' : ''}`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: bundle.xml });
console.log(`${rebuild ? 'Rebuilt' : 'Imported'} the edit (project ${projectId}).`);
if (imported.warnings.length) { console.log('\nNot carried over from Final Cut:'); for (const warning of imported.warnings) console.log(' - ' + warning); }

/** The editor's resumable protocol: POST size + fingerprint, then PUT checksummed chunks at the server's offset. */
async function upload(asset, file, label) {
  // Named and dated as the browser's File is, so a browser or MCP upload of the same file resumes this one.
  const info = await stat(file), fingerprint = `${basename(file)}:${info.size}:${Math.trunc(info.mtimeMs)}`;
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
const missing = [], sources = imported.media.filter(asset => !asset.sourceUrl);
console.log(`\n${imported.media.length} source files · ${imported.media.length - sources.length} already on the server`);
for (const [index, asset] of sources.entries()) {
  const label = `${index + 1}/${sources.length} ${asset.name}`, file = locateSource(asset, bundle.sources, found);
  if (!file) { missing.push(asset.name); console.log(`${label}: not found`); continue; }
  console.log(`\r${label}: ${await upload(asset, file, label)}   `);
}
if (missing.length) console.log(`\n${missing.length} files were not found: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}. Run again with --media <folder> to upload them.`);
console.log(`\nDone. Open ${server} — the project is on your Projects screen. Previews finish preparing on the server.`);
