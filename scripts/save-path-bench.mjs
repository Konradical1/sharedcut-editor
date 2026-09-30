/**
 * How long does the server's save path block its event loop? Measured on a copy of a real database.
 *
 *   node scripts/save-path-bench.mjs data/frameline.sqlite [--project "★ Part 1 v2"] [--edits 20] [--json out.json] [--server server/index.ts]
 *
 * The source database is only ever opened read-only and copied with VACUUM INTO into a temporary
 * folder; the server under test runs in a child process with that folder as its data directory, so
 * nothing is written to the source. Media files are not copied: every startup media job (preview,
 * camera, colour, re-probe, filmstrip and waveform upgrades) first checks that the original exists
 * under the data directory, so none of them runs. `--project` names a project, or the start of
 * one of its timelines; without a match the project with the most clips is used.
 *
 * The child records event-loop delay (perf_hooks.monitorEventLoopDelay at 1 ms resolution) and the
 * parent resets and reads it around each request. On Windows the timer ticks every ~15.6 ms, so an
 * idle loop already reads ~16 ms: `idleBlockMs` is that floor, and a request reading 20 ms blocked
 * the loop for a few ms at most.
 */
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';

const argv = process.argv.slice(2);

if (argv[0] === '--child') {
  const [, dataDir, serverModule] = argv;
  const started = performance.now();
  const { createFrameLineServer } = await import(pathToFileURL(serverModule).href);
  const app = createFrameLineServer({ dataDir, distDir: dataDir });
  const startupMs = performance.now() - started;
  const histogram = monitorEventLoopDelay({ resolution: 1 }); histogram.enable();
  const ms = value => Math.round(value / 1e4) / 100;
  process.on('message', message => {
    if (message === 'reset') { histogram.reset(); process.send({ reset: true }); }
    else if (message === 'stats') process.send({ stats: { max: ms(histogram.max), p50: ms(histogram.percentile(50)), p99: ms(histogram.percentile(99)), count: histogram.count } });
    else if (message === 'close') { const closing = performance.now(); void app.close().then(() => { process.send({ closed: performance.now() - closing }); process.exit(0); }); }
  });
  app.server.listen(0, '127.0.0.1', () => process.send({ port: app.server.address().port, startupMs }));
} else {
  const option = (name, fallback) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : fallback; };
  const source = resolve(argv[0] ?? '');
  if (!argv[0] || argv[0].startsWith('--') || !existsSync(source)) { console.error('Usage: node scripts/save-path-bench.mjs <frameline.sqlite> [--project name] [--edits 20] [--json out.json] [--server server/index.ts]'); process.exit(1); }
  const serverModule = resolve(option('server', fileURLToPath(new URL('../server/index.ts', import.meta.url))));
  const projectName = option('project', '★ Part 1 v2'), edits = Number(option('edits', 20));
  const { stateDelta, applyStateDelta } = await import(pathToFileURL(fileURLToPath(new URL('../src/services/stateDelta.ts', import.meta.url))).href);

  const dataDir = mkdtempSync(join(tmpdir(), 'save-path-bench-'));
  const copy = join(dataDir, 'frameline.sqlite');
  const reader = new DatabaseSync(source, { readOnly: true });
  reader.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`); reader.close();

  // Sign in as the owner of the benchmark project by minting a session in the copy.
  const token = randomBytes(32).toString('base64url');
  const db = new DatabaseSync(copy);
  const legacy = JSON.parse(String(db.prepare('SELECT state FROM workspace WHERE id=1').get().state));
  const target = legacy.projects.find(p => p.name === projectName || legacy.timelines.some(t => t.projectId === p.id && t.name.startsWith(projectName))) ?? legacy.projects.map(p => [p, legacy.clips.filter(c => c.projectId === p.id).length]).sort((a, b) => b[1] - a[1])[0][0];
  const ownerId = target.members.find(m => m.role === 'Owner').userId;
  db.prepare('INSERT INTO sessions(token,userId,expiresAt) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'), ownerId, Date.now() + 86400_000);
  db.close();
  const cookie = `frameline_session=${token}`;

  const start = () => new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--child', dataDir, serverModule], { execArgv: ['--experimental-strip-types', '--no-warnings'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    child.once('message', message => resolve({ child, ...message })); child.once('error', reject);
    child.once('exit', code => reject(new Error(`Server exited with ${code}`)));
  });
  const ask = (child, message, key) => new Promise(resolve => { const listen = reply => { if (key in reply) { child.off('message', listen); resolve(reply[key]); } }; child.on('message', listen); child.send(message); });
  const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)]; };
  const summary = samples => ({ n: samples.length, blocks: samples.map(s => Math.round(s.block)), wallP50: percentile(samples.map(s => s.wall), 50), wallP95: percentile(samples.map(s => s.wall), 95), blockP50: percentile(samples.map(s => s.block), 50), blockP95: percentile(samples.map(s => s.block), 95), blockMax: Math.max(...samples.map(s => s.block)) });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  let server = await start();
  const url = path => `http://127.0.0.1:${server.port}/api${path}`;
  const call = async (path, init = {}) => {
    const response = await fetch(url(path), { ...init, headers: { cookie, ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...init.headers } });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path}: ${response.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : undefined;
  };
  // One measured request: wall time from the client, longest event-loop stall inside the server.
  const measure = async (work) => {
    // reset() forgets the previous tick, so the first tick after it records nothing; Windows timers
    // tick every ~15 ms, so wait for one before the request or its stall is silently dropped.
    await ask(server.child, 'reset', 'reset'); await pause(40);
    const begun = performance.now(); const result = await work(); const wall = performance.now() - begun;
    await pause(30); // let broadcast/presence timers that the request scheduled run inside the window
    const stats = await ask(server.child, 'stats', 'stats');
    return { result, sample: { wall: Math.round(wall * 10) / 10, block: stats.max } };
  };
  const results = { source, project: target.name, startupMs: Math.round(server.startupMs) };

  await pause(500);
  const idle = await measure(() => pause(1000)); results.idleBlockMs = idle.sample.block;

  const loads = [];
  let envelope;
  for (let i = 0; i < 3; i++) { const run = await measure(() => call('/state')); envelope = run.result; loads.push(run.sample); await pause(200); }
  results.fullLoad = { ...summary(loads), bytes: JSON.stringify(envelope.state).length };

  let base = envelope.state, revision = envelope.revision;
  const project = base.projects.find(p => p.id === target.id);
  const clip = base.clips.filter(c => c.projectId === project.id).sort((a, b) => b.duration - a.duration)[0];
  let step = 0;
  // What the editor sends for a nudge: the clip, one new history entry in front, the project's modifiedAt.
  const edit = async () => {
    const current = base.clips.find(c => c.id === clip.id), shift = (step++ % 2 ? -1 : 1) / project.fps;
    const moved = { ...current, start: Math.max(0, current.start + shift) };
    const operation = { id: `bench-${randomBytes(8).toString('hex')}`, projectId: project.id, userId: ownerId, timestamp: Date.now(), targetId: clip.id, type: 'ClipMoved', description: 'Moved clip', oldState: [{ collection: 'clips', id: clip.id, value: { start: current.start } }], newState: [{ collection: 'clips', id: clip.id, value: { start: moved.start } }] };
    const next = { ...base, clips: base.clips.map(c => c.id === clip.id ? moved : c), operations: [operation, ...base.operations], projects: base.projects.map(p => p.id === project.id ? { ...p, modifiedAt: Date.now() } : p) };
    const response = await call('/state', { method: 'PATCH', body: JSON.stringify({ revision, delta: stateDelta(base, next) }) });
    base = applyStateDelta(next, response.delta); revision = response.revision;
  };
  const single = [];
  for (let i = 0; i < edits; i++) { single.push((await measure(edit)).sample); await pause(200); }
  results.singleEdit = summary(single);

  const burst = await measure(async () => { const walls = []; for (let i = 0; i < 20; i++) { const t = performance.now(); await edit(); walls.push(performance.now() - t); } return walls; });
  results.burst20 = { totalWall: burst.sample.wall, blockMax: burst.sample.block, perEditWallP95: Math.round(percentile(burst.result, 95) * 10) / 10 };
  await pause(300);

  // A first upload chunk writes the asset's progress (the upload path's progress update).
  const progress = [], added = [];
  for (let i = 0; i < 5; i++) {
    const add = await measure(() => call(`/media?projectId=${encodeURIComponent(project.id)}&name=bench-${i}.mp4&placeholder=1`, { method: 'POST' }));
    added.push(add.sample); const id = add.result.asset.id; await pause(100);
    await call(`/media/${id}/upload`, { method: 'POST', body: JSON.stringify({ size: 4096, fingerprint: 'bench' }) }); await pause(100);
    const chunk = randomBytes(1024);
    progress.push((await measure(() => call(`/media/${id}/upload`, { method: 'PUT', body: chunk, headers: { 'content-type': 'application/octet-stream', 'upload-offset': '0', 'upload-checksum': createHash('sha256').update(chunk).digest('hex') } }))).sample);
    await pause(200);
  }
  results.mediaAdd = summary(added); results.mediaProgress = summary(progress);

  const presence = [];
  for (let i = 0; i < 10; i++) { presence.push((await measure(() => call('/presence', { method: 'POST', body: JSON.stringify({ projectId: project.id, clientId: 'bench', playhead: i, active: true }) }))).sample); await pause(100); }
  results.presence = summary(presence);

  results.shutdownMs = Math.round(await ask(server.child, 'close', 'closed'));
  // Restart on the same copy: every save must have survived, and startup is timed again.
  server = await start();
  results.restartMs = Math.round(server.startupMs);
  const reloaded = await call('/state');
  results.reloadMatches = reloaded.revision >= revision && JSON.stringify(reloaded.state.clips.find(c => c.id === clip.id)) === JSON.stringify(base.clips.find(c => c.id === clip.id)) && reloaded.state.operations.length === base.operations.length && reloaded.state.media.length === base.media.length + 5;
  await ask(server.child, 'close', 'closed');
  rmSync(dataDir, { recursive: true, force: true });

  const json = option('json');
  if (json) writeFileSync(json, JSON.stringify(results, null, 1));
  console.log(JSON.stringify(results, null, 1));
}
