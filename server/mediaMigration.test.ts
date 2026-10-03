import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import type { MediaAsset } from '../src/state/models.ts';
import { migrateAsset, needsMigration, sweepPreparedTemp } from './mediaMigration.ts';
import { probeMedia } from './media.ts';
import { createFrameLineServer } from './index.ts';

const exec = promisify(execFile);
const ff = (args: string[]) => exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
const roomy = () => 1e12;

/** media/<id>/ as an older build left it: a red original, a green color-v1 (so the source is visible), and the whole old set. */
async function oldAsset(root: string, id: string, options: { alpha?: boolean } = {}) {
  const dir = join(root, 'media', id), prepared = join(dir, 'prepared'), base = `/api/media/${id}/files`;
  await mkdir(prepared, { recursive: true });
  await ff(['-f', 'lavfi', '-i', 'color=red:s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le', '-f', 'mov', join(dir, 'original')]);
  const intra = ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1'];
  await ff(['-f', 'lavfi', '-i', 'color=green:s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
    '-map', '0:v', ...intra, '-pix_fmt', 'yuv422p10le', '-an', join(prepared, 'color-v1.mp4'),
    '-map', '0:v', '-map', '1:a', ...intra, '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(prepared, 'proxy.mp4'),
    '-map', '0:v', '-map', '1:a', '-vf', 'scale=160:-2', ...intra, '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(prepared, 'proxy-half-v1.mp4'),
    '-map', '0:v', '-map', '1:a', '-vf', 'scale=80:-2', ...intra, '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(prepared, 'proxy-quarter-v1.mp4'),
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(prepared, 'stream-v2.mp4'),
    '-map', '0:v', '-map', '1:a', '-vf', 'scale=160:-2', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(prepared, 'stream-low-v1.mp4'),
    '-map', '1:a', '-c:a', 'aac', join(prepared, 'audio-v1.m4a'),
    '-map', '0:v', '-frames:v', '1', join(prepared, 'thumbnail.jpg')]);
  const asset = { id, projectId: 'p', name: `${id}.mov`, kind: 'video', binId: 'all', duration: 2, fps: 24, resolution: '320 × 180', size: '1 MB', status: 'ready', progress: 100, hasAudio: true, cameraMetadataVersion: 2,
    thumbnail: `${base}/thumbnail.jpg`, proxyUrl: `${base}/proxy.mp4`, colorProxyUrl: `${base}/color-v1.mp4`, audioProxyUrl: `${base}/audio-v1.m4a`,
    proxyVariants: { '1/2': `${base}/proxy-half-v1.mp4`, '1/4': `${base}/proxy-quarter-v1.mp4`, Stream: `${base}/stream-v2.mp4`, StreamLow: `${base}/stream-low-v1.mp4` } } as MediaAsset;
  if (options.alpha) Object.assign(asset, { hasAlpha: true, proxyUrl: `${base}/proxy-alpha-v1.webm` }), await writeFile(join(prepared, 'proxy-alpha-v1.webm'), 'webm');
  // The server's update: the row is the asset plus each saved patch.
  const rows: Partial<MediaAsset>[] = [];
  const run = (current: MediaAsset, extra: Partial<Parameters<typeof migrateAsset>[1]> = {}) => migrateAsset(current, { mediaDir: dir, baseUrl: base, freeBytes: roomy, update: patch => { rows.push(patch); }, ...extra });
  return { dir, prepared, base, asset, rows, run, row: () => Object.assign({}, asset, ...rows) as MediaAsset };
}
/** Average colour of the first frame, as RGB. */
const colour = async (file: string) => [...(await ff(['-i', file, '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'])).stdout];
const pixFmt = async (file: string) => (await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', file])).stdout.trim();

test('an old asset moves to full-v3 + stream-v2 + stream-low-v2, its row is updated and the replaced files are deleted', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameline-migrate-'));
  try {
    const old = await oldAsset(root, 'a');
    assert.equal(needsMigration(old.asset, old.prepared), true);
    const result = await old.run(old.asset);
    assert.equal(result.status, 'migrated'); assert.ok(result.freed > 0);
    const row = old.row();
    assert.match(row.proxyUrl!, /^\/api\/media\/a\/files\/full-v3\.mp4\?v=\w+$/); assert.equal(row.colorProxyUrl, row.proxyUrl);
    assert.equal(row.proxyVariants!.Stream, '/api/media/a/files/stream-v2.mp4', 'stream-v2 keeps its URL, so remote caches stay valid');
    assert.equal(row.proxyVariants!['1/2'], row.proxyVariants!.Stream);
    assert.match(row.proxyVariants!.StreamLow, /\/stream-low-v2\.mp4\?v=\w+$/); assert.equal(row.proxyVariants!['1/4'], row.proxyVariants!.StreamLow);
    assert.equal(row.audioProxyUrl, '/api/media/a/files/audio-v1.m4a');
    assert.deepEqual((await readdir(old.prepared)).sort(), ['audio-v1.m4a', 'full-v3.mp4', 'stream-low-v2.mp4', 'stream-v2.mp4', 'thumbnail.jpg']);
    const full = join(old.prepared, 'full-v3.mp4');
    assert.equal(await pixFmt(full), 'yuv422p10le'); assert.equal(await pixFmt(join(old.prepared, 'stream-low-v2.mp4')), 'yuv420p');
    const probed = await probeMedia(full); assert.ok(probed.hasAudio); assert.ok(Math.abs(probed.duration - 2) < .05); assert.equal(probed.colorRange, 'tv');
    const [r, g] = await colour(full); assert.ok(g > 100 && r < 60, `built from color-v1 (green), got ${r},${g}`);
    assert.equal(needsMigration(row, old.prepared), false);
    assert.equal((await old.run(row)).status, 'current', 'a second pass has nothing to do');

    // A corrected colour matrix rebuilds from the camera original, under new URLs, and leaves stream-v2 alone.
    const rebuilt = await old.run(row, { fromOriginal: true });
    assert.equal(rebuilt.status, 'migrated');
    const again = old.row(); assert.notEqual(again.proxyUrl, row.proxyUrl); assert.equal(again.proxyVariants!.Stream, row.proxyVariants!.Stream);
    const [r2, g2] = await colour(full); assert.ok(r2 > 200 && g2 < 60, `rebuilt from the original (red), got ${r2},${g2}`);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an interrupted migration resumes: a cancelled encode, a kill before the row was saved, a kill before the deletes', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameline-migrate-resume-'));
  try {
    const old = await oldAsset(root, 'b'), before = (await readdir(old.prepared)).sort();
    // Cancelled mid-encode: nothing changes, nothing is left behind.
    const controller = new AbortController();
    const running = old.run(old.asset, { signal: controller.signal });
    for (let i = 0; i < 400 && !(await readdir(old.prepared)).some(name => name.startsWith('.preview-')); i++) await new Promise(r => setTimeout(r, 5));
    controller.abort();
    await assert.rejects(running, /Canceled/);
    assert.deepEqual((await readdir(old.prepared)).sort(), before); assert.equal(old.rows.length, 0);

    // Killed after the files were renamed in but before the row was saved (the update throws where the process died),
    // with a temp folder from an even earlier kill still lying around.
    const stale = join(old.prepared, '.preview-killed'); await mkdir(stale); await writeFile(join(stale, 'full-v3.mp4'), 'half an encode');
    const hourAgo = new Date(Date.now() - 2 * 3600_000); await utimes(join(stale, 'full-v3.mp4'), hourAgo, hourAgo); await utimes(stale, hourAgo, hourAgo);
    await assert.rejects(old.run(old.asset, { update: () => { throw new Error('killed'); } }), /killed/);
    assert.ok(existsSync(join(old.prepared, 'full-v3.mp4')) && existsSync(join(old.prepared, 'proxy.mp4')), 'old files stay until the row points away from them');
    const encoded = (await stat(join(old.prepared, 'full-v3.mp4'))).mtimeMs;

    // The next start: the sweep takes the stale temp folder, the pass keeps the verified file and finishes.
    assert.equal(sweepPreparedTemp(join(root, 'media')), 1); assert.ok(!existsSync(stale));
    assert.equal(needsMigration(old.asset, old.prepared), true);
    assert.equal((await old.run(old.asset)).status, 'migrated');
    assert.equal((await stat(join(old.prepared, 'full-v3.mp4'))).mtimeMs, encoded, 'a verified full-v3 from the killed run is not encoded again');
    assert.ok(!existsSync(join(old.prepared, 'proxy.mp4')));

    // Killed after the row was saved but before the deletes: the leftovers alone make it due, and it only deletes.
    await writeFile(join(old.prepared, 'proxy-quarter-v1.mp4'), 'left over');
    assert.equal(needsMigration(old.row(), old.prepared), true);
    const rows = old.rows.length;
    assert.equal((await old.run(old.row())).status, 'cleaned'); assert.equal(old.rows.length, rows, 'nothing is re-saved');
    assert.ok(!existsSync(join(old.prepared, 'proxy-quarter-v1.mp4')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('graphics lose their opaque proxies, a missing proxy is rebuilt from the original, and low disk refuses', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameline-migrate-edge-'));
  try {
    // A graphic: its alpha WebM stays, the opaque proxy.mp4 and color-v1 go, and colorProxyUrl is cleared by name.
    const graphic = await oldAsset(root, 'g', { alpha: true });
    assert.equal(needsMigration(graphic.asset, graphic.prepared), true);
    assert.equal((await graphic.run(graphic.asset)).status, 'cleaned');
    assert.ok('colorProxyUrl' in graphic.rows[0] && graphic.rows[0].colorProxyUrl === undefined);
    assert.ok(existsSync(join(graphic.prepared, 'proxy-alpha-v1.webm')) && !existsSync(join(graphic.prepared, 'proxy.mp4')) && !existsSync(join(graphic.prepared, 'color-v1.mp4')));
    assert.equal(needsMigration(graphic.row(), graphic.prepared), false);

    // A Resolve import whose proxy-v2.mp4 is gone and that never had a grading proxy or a Stream file.
    const orphan = await oldAsset(root, 'o');
    for (const name of ['color-v1.mp4', 'stream-v2.mp4']) await rm(join(orphan.prepared, name));
    const missing = { ...orphan.asset, proxyUrl: '/api/media/o/files/proxy-v2.mp4', colorProxyUrl: undefined };
    assert.equal(needsMigration(missing, orphan.prepared), true);
    assert.equal((await orphan.run(missing)).status, 'migrated');
    const row = Object.assign({}, missing, ...orphan.rows) as MediaAsset;
    assert.match(row.proxyVariants!.Stream, /stream-v2\.mp4\?v=\w+$/, 'a rebuilt Stream gets a URL no cache has seen');
    const [r, g] = await colour(join(orphan.prepared, 'full-v3.mp4')); assert.ok(r > 200 && g < 60, `rebuilt from the original, got ${r},${g}`);
    assert.equal(await pixFmt(join(orphan.prepared, 'stream-v2.mp4')), 'yuv420p');

    // Not enough room for the estimate plus a gigabyte: refused before anything is written or saved.
    const full = await oldAsset(root, 'd'), before = (await readdir(full.prepared)).sort();
    assert.equal((await full.run(full.asset, { freeBytes: () => 2 ** 30 })).status, 'low-disk');
    assert.deepEqual((await readdir(full.prepared)).sort(), before); assert.equal(full.rows.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the startup sweep takes only stale temp folders inside media/*/prepared', async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameline-sweep-'));
  try {
    const prepared = join(root, 'media', 'x', 'prepared'), old = new Date(Date.now() - 2 * 3600_000);
    for (const name of ['.preview-a', '.color-b', '.thumbnail-c', '.filmstrip-d', '.preview-fresh']) await mkdir(join(prepared, name), { recursive: true });
    await writeFile(join(prepared, 'hdr-arib-std-b67-100.cube'), 'table'); await writeFile(join(prepared, 'full-v3.mp4'), 'keep');
    await mkdir(join(root, 'transitions', '.preview-z'), { recursive: true });
    for (const name of ['.preview-a', '.color-b', '.thumbnail-c', '.filmstrip-d', 'hdr-arib-std-b67-100.cube', 'full-v3.mp4']) await utimes(join(prepared, name), old, old);
    await utimes(join(root, 'transitions', '.preview-z'), old, old);
    // A temp folder whose encode is still writing counts as fresh, however old the folder itself is.
    await mkdir(join(prepared, '.preview-live')); await writeFile(join(prepared, '.preview-live', 'full-v3.mp4'), 'growing'); await utimes(join(prepared, '.preview-live'), old, old);
    assert.equal(sweepPreparedTemp(join(root, 'media')), 5);
    assert.deepEqual((await readdir(prepared)).sort(), ['.preview-fresh', '.preview-live', 'full-v3.mp4']);
    assert.ok(existsSync(join(root, 'transitions', '.preview-z')), 'never outside media/*/prepared');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the server migrates an older import at startup on its media queue and sweeps the temp folder a kill left', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameline-migrate-server-')), footage = join(root, 'footage'), dataDir = join(root, 'data');
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  await mkdir(footage);
  await ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(footage, 'shot.mp4')]);
  const start = async () => { const app = createFrameLineServer({ dataDir }); await new Promise<void>(r => app.server.listen(0, '127.0.0.1', r)); return { app, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` }; };
  let { app, base } = await start();
  try {
    const signup = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Agent', email: 'migrate@example.test', password: 'migrate-test-password-2026' }) });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const media = async (done: (a: MediaAsset) => boolean) => { for (let i = 0; i < 400; i++) { const a = (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()).state.media[0]; if (a && done(a)) return a as MediaAsset; await new Promise(r => setTimeout(r, 250)); } throw new Error('asset never settled'); };
    await exec(process.execPath, ['scripts/import-folder.mjs', '--name', 'Reel', footage], { env: { ...process.env, FRAME_LINE_COOKIE: cookie, FRAME_LINE_URL: base } });
    const fresh = await media(a => a.status === 'ready' && !a.preparationStage);
    assert.match(fresh.proxyUrl!, /\/full-v3\.mp4$/, 'a new upload is prepared straight onto the v3 set');
    await app.close();

    // Turn it into what an older build left: proxy.mp4 + color-v1 + the all-intra pair + stream-low-v1, and a killed encode.
    const prepared = join(dataDir, 'media', fresh.id, 'prepared'), url = (name: string) => `/api/media/${fresh.id}/files/${name}`;
    await copyFile(join(prepared, 'full-v3.mp4'), join(prepared, 'color-v1.mp4')); await rename(join(prepared, 'full-v3.mp4'), join(prepared, 'proxy.mp4'));
    await copyFile(join(prepared, 'stream-low-v2.mp4'), join(prepared, 'proxy-quarter-v1.mp4')); await copyFile(join(prepared, 'stream-v2.mp4'), join(prepared, 'proxy-half-v1.mp4')); await rename(join(prepared, 'stream-low-v2.mp4'), join(prepared, 'stream-low-v1.mp4'));
    const killed = join(prepared, '.color-killed'), old = new Date(Date.now() - 2 * 3600_000); await mkdir(killed); await utimes(killed, old, old);
    const db = new DatabaseSync(join(dataDir, 'frameline.sqlite'));
    const row = db.prepare('SELECT state FROM workspace WHERE id=1').get() as { state: string }, state = JSON.parse(row.state);
    state.media = state.media.map((m: MediaAsset) => ({ ...m, proxyUrl: url('proxy.mp4'), colorProxyUrl: url('color-v1.mp4'), proxyVariants: { '1/2': url('proxy-half-v1.mp4'), '1/4': url('proxy-quarter-v1.mp4'), Stream: url('stream-v2.mp4'), StreamLow: url('stream-low-v1.mp4') } }));
    db.prepare('UPDATE workspace SET state=? WHERE id=1').run(JSON.stringify(state)); db.close();

    ({ app, base } = await start());
    const migrated = await media(a => a.proxyUrl!.includes('/full-v3.mp4?v=') && !existsSync(join(prepared, 'proxy.mp4')));
    assert.equal(migrated.colorProxyUrl, migrated.proxyUrl); assert.equal(migrated.proxyVariants!.Stream, url('stream-v2.mp4'));
    assert.match(migrated.proxyVariants!['1/4'], /stream-low-v2\.mp4\?v=/);
    assert.deepEqual((await readdir(prepared)).sort(), ['audio-v1.m4a', 'filmstrip.jpg', 'full-v3.mp4', 'stream-low-v2.mp4', 'stream-v2.mp4', 'thumbnail.jpg']);
    for (const link of [migrated.proxyUrl!, migrated.proxyVariants!['1/4']]) assert.equal((await fetch(base + link, { headers: { cookie, range: 'bytes=0-99' } })).status, 206, link);
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
