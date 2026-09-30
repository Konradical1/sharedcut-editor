import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createFrameLineServer } from './index.ts';
import { PROBE_VERSION } from './media.ts';

const exec = promisify(execFile);

test('a startup re-probe of an old HLG phone clip reports it upright and re-prepares it under new URLs', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameline-reprobe-')), footage = join(root, 'footage'), dataDir = join(root, 'data');
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  const ff = (args: string[]) => exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', ...args]);
  await mkdir(footage);
  const coded = join(root, 'coded.mp4');
  await ff(['-f', 'lavfi', '-i', 'testsrc2=s=128x72:r=24:d=0.5', '-vf', 'setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc', '-pix_fmt', 'yuv420p10le', '-c:v', 'libx264', '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', coded]);
  await ff(['-display_rotation', '90', '-i', coded, '-c', 'copy', join(footage, 'IMG_0001.MOV')]);
  const start = async () => {
    const app = createFrameLineServer({ dataDir });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return { app, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
  };
  let { app, base } = await start();
  try {
    const signup = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Agent', email: 'agent@example.test', password: 'reprobe-test-password-2026' }) });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const asset = async (done: (a: any) => boolean) => {
      for (let i = 0; i < 400; i++) { const a = (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json()).state.media[0]; if (a && done(a)) return a; await new Promise(r => setTimeout(r, 250)); }
      throw new Error('asset never settled');
    };
    await exec(process.execPath, ['scripts/import-folder.mjs', '--name', 'Reel', footage], { env: { ...process.env, FRAME_LINE_COOKIE: cookie, FRAME_LINE_URL: base } });
    const first = await asset(a => a.status === 'ready' && a.colorProxyUrl && !a.preparationStage);
    assert.equal(first.resolution, '72 × 128'); assert.ok(!first.proxyUrl.includes('?'), 'a first preparation keeps plain URLs');
    await app.close();

    // What an asset imported before PROBE_VERSION 2 looks like: landscape, no transfer, no probe version.
    const db = new DatabaseSync(join(dataDir, 'frameline.sqlite'));
    const row = db.prepare('SELECT state FROM workspace WHERE id=1').get() as { state: string }, state = JSON.parse(row.state);
    state.media = state.media.map((m: any) => ({ ...m, resolution: '128 × 72', width: 128, height: 72, colorTransfer: undefined, probeVersion: undefined }));
    db.prepare('UPDATE workspace SET state=? WHERE id=1').run(JSON.stringify(state)); db.close();

    ({ app, base } = await start());
    const again = await asset(a => a.probeVersion === PROBE_VERSION && a.status === 'ready' && a.proxyUrl.includes('?v=') && a.colorProxyUrl?.includes('?v=') && !a.preparationStage);
    assert.equal(again.resolution, '72 × 128'); assert.equal(again.colorTransfer, 'arib-std-b67');
    for (const url of [again.proxyUrl, again.thumbnail, again.colorProxyUrl, ...Object.values(again.proxyVariants)] as string[]) {
      assert.match(url, /\?v=/, `${url} is a new URL, not the cached one`);
      assert.equal((await fetch(base + url, { headers: { cookie } })).status, 200, url);
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
