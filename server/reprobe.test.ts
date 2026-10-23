import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
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
    assert.match(first.proxyUrl, /\/full-v3\.mp4$/); assert.equal(first.colorProxyUrl, first.proxyUrl, 'Full and Color share full-v3');
    await app.close();

    // What an asset imported before PROBE_VERSION 2 looks like: landscape, no transfer, no probe version.
    const db = new DatabaseSync(join(dataDir, 'frameline.sqlite'));
    const row = db.prepare('SELECT state FROM workspace WHERE id=1').get() as { state: string }, state = JSON.parse(row.state);
    state.media = state.media.map((m: any) => ({ ...m, resolution: '128 × 72', width: 128, height: 72, colorTransfer: undefined, probeVersion: undefined }));
    db.prepare('UPDATE workspace SET state=? WHERE id=1').run(JSON.stringify(state)); db.close();

    ({ app, base } = await start());
    const again = await asset(a => a.probeVersion === PROBE_VERSION && a.status === 'ready' && a.proxyUrl.includes('?v=') && a.colorProxyUrl?.includes('?v=') && !a.preparationStage);
    assert.equal(again.resolution, '72 × 128'); assert.equal(again.colorTransfer, 'arib-std-b67'); assert.equal(again.colorProxyUrl, again.proxyUrl);
    for (const url of [again.proxyUrl, again.thumbnail, again.colorProxyUrl, ...Object.values(again.proxyVariants)] as string[]) {
      assert.match(url, /\?v=/, `${url} is a new URL, not the cached one`);
      assert.equal((await fetch(base + url, { headers: { cookie } })).status, 200, url);
    }
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});

test('a startup camera check labels older iPhone imports Apple Log in place; a clip\'s own input stays and Apple Log saves', { timeout: 120000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'frameline-applelog-')), footage = join(root, 'footage'), dataDir = join(root, 'data');
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  await mkdir(footage);
  // What Blackmagic Camera writes on an iPhone: 10-bit 4:2:2, BT.2020 primaries and matrix, no transfer, Apple tags on the container.
  for (const name of ['A001.mov', 'A002.mov']) await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=128x72:r=24:d=0.5', '-vf', 'setparams=range=tv:color_primaries=bt2020:colorspace=bt2020nc',
    '-pix_fmt', 'yuv422p10le', '-c:v', 'libx264', '-movflags', 'use_metadata_tags', '-metadata', 'com.apple.proapps.manufacturer=Apple Inc.', '-metadata', 'com.apple.quicktime.software=Blackmagic Cam 3.5.200045',
    '-metadata', 'com.blackmagic-design.camera.lensType=iPhone 15 Pro Max 24mm', join(footage, name)]);
  const start = async () => {
    const app = createFrameLineServer({ dataDir });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    return { app, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
  };
  let { app, base } = await start();
  try {
    const signup = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Agent', email: 'agent@example.test', password: 'apple-log-test-password-2026' }) });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0], read = async () => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json());
    const settled = async (done: (media: any[]) => boolean) => {
      for (let i = 0; i < 400; i++) { const media = (await read()).state.media.sort((a: any, b: any) => a.name.localeCompare(b.name)); if (media.length === 2 && done(media)) return media; await new Promise(r => setTimeout(r, 250)); }
      throw new Error('media never settled');
    };
    await exec(process.execPath, ['scripts/import-folder.mjs', '--name', 'Phone', footage], { env: { ...process.env, FRAME_LINE_COOKIE: cookie, FRAME_LINE_URL: base } });
    const imported = await settled(media => media.every(a => a.status === 'ready' && !a.preparationStage));
    for (const a of imported) {
      assert.deepEqual([a.inputProfile, a.inputGamut, a.colorMatrix, a.cameraMetadataVersion, a.colorTransfer], ['Apple Log', 'Rec.2020', 'bt2020nc', 3, undefined], 'a new import reads Apple Log; no HDR transfer, so no tone map');
      assert.equal(a.colorEvidence, 'Apple camera metadata (iPhone 15 Pro Max 24mm, Blackmagic Cam 3.5.200045): BT.2020, Apple Log');
    }
    // A clip whose input the editor chose, and a wide-gamut grade on Apple Log: the save check accepts both.
    const state = (await read()), track = state.state.tracks.find((t: any) => t.kind === 'video'), timeline = state.state.timelines[0];
    const clip = (id: string, properties: Record<string, unknown>) => ({ id, projectId: timeline.projectId, timelineId: timeline.id, trackId: track.id, mediaId: imported[0].id, name: id, start: id === 'manual' ? 0 : 1, duration: .5, sourceIn: 0, color: '#888888', disabled: false, properties, effects: [] });
    const cst = { id: 'cst', type: 'cst', enabled: true, inputGamma: 'Apple Log', inputGamut: 'Rec.2020', outputGamma: 'DaVinci Intermediate', outputGamut: 'DaVinci Wide Gamut', toneMapping: 'none', gamutMapping: 'none' };
    const delta = { clips: { upsert: [clip('manual', { inputProfile: 'Gamma 2.4', inputGamut: 'Rec.709' }), clip('graded', { colorPipeline: 'nodes-v2', inputProfile: 'Apple Log', inputGamut: 'Rec.2020' })], remove: [] },
      nodes: { upsert: [{ id: 'input', projectId: timeline.projectId, clipId: 'graded', name: 'Input CST', kind: 'serial', enabled: true, order: 1, parameters: {}, effects: [cst] }], remove: [] } };
    for (let attempt = 0, revision = state.revision; ; attempt++) {
      const saved = await fetch(`${base}/api/state`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ revision, delta }) });
      if (saved.status === 200) break;
      assert.ok(saved.status === 409 && attempt < 20, `Apple Log clips and nodes save: ${saved.status} ${await saved.text()}`); revision = (await read()).revision;
    }
    await app.close();

    // What these looked like before Apple Log: untagged at camera metadata version 2. The first is ready, the second was still preparing.
    const db = new DatabaseSync(join(dataDir, 'frameline.sqlite'));
    const row = db.prepare('SELECT state FROM workspace WHERE id=1').get() as { state: string }, saved = JSON.parse(row.state);
    saved.media = saved.media.map((m: any) => ({ ...m, inputProfile: undefined, inputGamut: undefined, colorEvidence: 'Camera profile untagged; set input manually for log footage', cameraMetadataVersion: 2, ...m.name === 'A002.mov' && { status: 'processing', progress: 40 } }));
    db.prepare('UPDATE workspace SET state=? WHERE id=1').run(JSON.stringify(saved)); db.close();
    const full = join(dataDir, 'media', imported[0].id, 'prepared', 'full-v3.mp4'), written = (await stat(full)).mtimeMs;

    ({ app, base } = await start());
    const [ready, preparing] = await settled(media => media.every(a => a.cameraMetadataVersion === 3 && a.status === 'ready' && !a.preparationStage));
    assert.deepEqual([ready.inputProfile, ready.inputGamut, ready.colorEvidence], ['Apple Log', 'Rec.2020', imported[0].colorEvidence], 'the ready asset is labelled');
    for (const key of ['proxyUrl', 'colorProxyUrl', 'thumbnail']) assert.equal(ready[key], imported[0][key], `${key}: not prepared again`);
    assert.equal((await stat(full)).mtimeMs, written, 'full-v3 is the file it was');
    assert.match(preparing.proxyUrl, /\?v=/, 'the rewound rows were loaded: the interrupted one prepared again');
    assert.equal(preparing.inputProfile, 'Apple Log', 'the interrupted one is labelled by its preparation');
    const clips = (await read()).state.clips;
    assert.deepEqual(clips.find((c: any) => c.id === 'manual').properties, { inputProfile: 'Gamma 2.4', inputGamut: 'Rec.709' }, 'the editor\'s choice for a clip stays');
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
