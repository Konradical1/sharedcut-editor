import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { maskAnalysis, maskSourceFingerprint, resolveSmartMaskArtifact, resolveSmartMaskRepairBase, runMaskProcess, smartMaskService, validateMaskManifest } from './smartMask.ts';
import { createSmartMask, smartMaskSignature, validateSmartMaskBindings } from '../src/services/smartMask.ts';
import type { SmartMaskManifest } from '../src/services/smartMask.ts';
import type { Clip, MediaAsset } from '../src/state/models.ts';
import { createFrameLineServer } from './index.ts';
import { defaultShape } from '../src/services/shapes.ts';

const asset = { id: 'media', projectId: 'project', kind: 'video', duration: 1, fps: 2, resolution: '64 × 32', inputProfile: 'Rec.709' } as MediaAsset;
const clip = { id: 'clip', projectId: 'project', mediaId: 'media', sourceIn: 0, start: 0, duration: 1, properties: {}, effects: [] } as unknown as Clip;
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'frameline-mask-test-')), key = 'a'.repeat(64), root = join(directory, key), source = join(directory, 'original');
  mkdirSync(join(root, 'frames'), { recursive: true }); mkdirSync(join(root, 'source'));
  writeFileSync(source, 'immutable source');
  const mask = createSmartMask(clip, asset, 'subject');
  mask.settings = { preserveMotionBlur: false, edgeRadius: 16, quality: 'preview' };
  mask.prompts = [{ id: 'p', time: 0, kind: 'include', radius: .01, points: [{ x: .5, y: .5 }] }];
  const signature = smartMaskSignature(mask); mask.result = { key, signature };
  const manifest: SmartMaskManifest = { version: 1, key, signature, projectId: clip.projectId, mediaId: asset.id, sourceFingerprint: maskSourceFingerprint(source), engine: 'fixture', modelRevision: 'fixture', quality: 'preview', width: 64, height: 32, sourceTimes: [0, .5], frames: [{ index: 0, time: 0, file: 'frames/0.png' }, { index: 1, time: .5, file: 'frames/1.png' }], range: { start: 0, end: 1 }, alpha: 'gray16' };
  const pngHeader = Buffer.alloc(26); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader); pngHeader.write('IHDR', 12, 'ascii'); pngHeader.writeUInt32BE(64, 16); pngHeader.writeUInt32BE(32, 20); pngHeader[24] = 16;
  for (const frame of manifest.frames) { writeFileSync(join(root, frame.file), pngHeader); writeFileSync(join(root, 'source', `${frame.index}.jpg`), 'JPEG fixture'); }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'binding.json'), JSON.stringify({ projectId: clip.projectId, clipId: clip.id, maskId: mask.id, signature, sourceFingerprint: maskSourceFingerprint(source), analysisIdentity: maskAnalysis(clip, asset).identity, workerIdentity: 'fixture', direction: 'both', anchorTime: 0 }));
  return { directory, key, root, source, mask, signature, manifest };
}

test('completed mask resolver rejects cross-project reuse, stale edits/source/color and incomplete frames', () => {
  const f = fixture();
  try {
    assert.equal(resolveSmartMaskArtifact(f.directory, clip, f.mask, f.source, asset).directory, f.root);
    assert.equal(resolveSmartMaskArtifact(f.directory, { ...clip, id: 'pasted-clip' }, { ...f.mask, id: 'pasted-mask' }, f.source, asset).directory, f.root);
    assert.throws(() => resolveSmartMaskArtifact(f.directory, { ...clip, projectId: 'outsider' }, f.mask, f.source, asset), /another source/);
    assert.throws(() => resolveSmartMaskArtifact(f.directory, clip, { ...f.mask, range: { start: .1, end: 1 } }, f.source, asset), /analyze the current/);
    assert.throws(() => resolveSmartMaskArtifact(f.directory, { ...clip, properties: { inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' } }, f.mask, f.source, asset), /stale/);
    assert.throws(() => resolveSmartMaskArtifact(f.directory, clip, { ...f.mask, result: { key: '../original', signature: f.signature } }, f.source, asset), /analyze/);
    // The frame showing at range.start belongs to the range even when its timestamp is a hair earlier.
    validateMaskManifest({ ...f.manifest, sourceTimes: [0, .5], range: { start: .01, end: 1 } }, { ...f, mask: { ...f.mask, range: { start: .01, end: 1 } } }, f.root);
    const missing = { ...f.manifest, frames: [f.manifest.frames[1]] };
    assert.throws(() => validateMaskManifest(missing, f, f.root), /coverage/);
    assert.throws(() => validateMaskManifest({ ...missing, range: { start: .5, end: 1 } }, { ...f, direction: 'both', anchorTime: 0 }, f.root), /requested direction and range/);
    assert.throws(() => validateMaskManifest({ ...f.manifest, frames: [{ ...f.manifest.frames[0], file: '../original' }, f.manifest.frames[1]] }, f, f.root), /incomplete/);
    const png = readFileSync(join(f.root, 'frames', '1.png')); png[24] = 8; writeFileSync(join(f.root, 'frames', '1.png'), png);
    assert.throws(() => resolveSmartMaskArtifact(f.directory, clip, f.mask, f.source, asset), /16-bit/);
    rmSync(join(f.root, 'frames', '1.png'));
    assert.throws(() => resolveSmartMaskArtifact(f.directory, clip, f.mask, f.source, asset), /incomplete/);
    writeFileSync(f.source, 'changed original source');
    assert.throws(() => resolveSmartMaskArtifact(f.directory, clip, f.mask, f.source, asset), /stale/);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('job authorization survives restart and cancellation preserves historical completed artifacts', async () => {
  const f = fixture(), pending = 'b'.repeat(64);
  writeFileSync(join(f.directory, `${f.key}.job.json`), JSON.stringify({ key: f.key, signature: f.signature, projectId: 'project', clipId: 'clip', maskId: 'subject', status: 'ready', progress: 100 }));
  writeFileSync(join(f.directory, `${pending}.job.json`), JSON.stringify({ key: pending, signature: f.signature, projectId: 'project', clipId: 'clip', maskId: 'subject', status: 'processing', progress: 42 }));
  const service = smartMaskService(f.directory);
  try {
    assert.throws(() => service.get('outsider', f.key), /not found/);
    assert.throws(() => service.cancel('outsider', f.key), /not found/);
    assert.throws(() => service.file('outsider', f.key, 'frames', 0), /not found/);
    assert.throws(() => service.file('project', f.key, 'frames', -1), /not found/);
    assert.equal(service.get('project', pending).status, 'failed');
    assert.match(service.get('project', pending).error!, /restarted/);
    assert.throws(() => service.file('project', pending, 'manifest'), /not ready/);
    service.cancel('project', f.key);
    assert.equal(service.get('project', f.key).status, 'ready');
    assert.ok(existsSync(service.file('project', f.key, 'frames', 1)));
    assert.equal(JSON.parse(readFileSync(join(f.directory, `${pending}.job.json`), 'utf8')).status, 'failed');
  } finally { await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('repair-only reuse requires every unpainted frame and unchanged inference identity', () => {
  const f = fixture();
  try {
    const repaired = { ...f.mask, repairs: [{ id: 'repair', time: 0, kind: 'background' as const, radius: .01, points: [{ x: .2, y: .3 }] }] };
    assert.equal(resolveSmartMaskRepairBase(f.directory, clip, repaired, f.source, asset, 'fixture', 'both', 0), undefined);
    mkdirSync(join(f.root, 'base-frames'));
    for (const frame of f.manifest.frames) writeFileSync(join(f.root, 'base-frames', `${frame.index}.png`), readFileSync(join(f.root, frame.file)));
    assert.equal(resolveSmartMaskRepairBase(f.directory, clip, repaired, f.source, asset, 'fixture', 'both', 0), f.root);
    assert.equal(resolveSmartMaskRepairBase(f.directory, clip, { ...repaired, repairs: [{ ...repaired.repairs[0], kind: 'unknown' }] }, f.source, asset, 'fixture', 'both', 0), f.root);
    assert.equal(resolveSmartMaskRepairBase(f.directory, clip, repaired, f.source, asset, 'different-model', 'both', 0), undefined);
    assert.equal(resolveSmartMaskRepairBase(f.directory, clip, repaired, f.source, asset, 'fixture', 'forward', 0), undefined);
    assert.equal(resolveSmartMaskRepairBase(f.directory, clip, repaired, f.source, asset, 'fixture', 'both', .5), undefined);
    assert.equal(resolveSmartMaskRepairBase(f.directory, { ...clip, projectId: 'other' }, repaired, f.source, asset, 'fixture', 'both', 0), undefined);
    assert.equal(resolveSmartMaskRepairBase(f.directory, clip, { ...repaired, prompts: [{ ...f.mask.prompts[0], points: [{ x: .9, y: .8 }] }] }, f.source, asset, 'fixture', 'both', 0), undefined);
    rmSync(join(f.root, 'base-frames', '1.png'));
    assert.equal(resolveSmartMaskRepairBase(f.directory, clip, repaired, f.source, asset, 'fixture', 'both', 0), undefined);
  } finally { rmSync(f.directory, { recursive: true, force: true }); }
});

test('invalid prompts and node bindings are rejected before a model process is started', async () => {
  const f = fixture(), service = smartMaskService(f.directory);
  try {
    const mask = { ...f.mask, prompts: [{ ...f.mask.prompts[0], points: [{ x: -1, y: .4 }] }] };
    await assert.rejects(service.enqueue({ clip, asset, mask, sourcePath: f.source, signature: f.signature, direction: 'both', anchorTime: 0 }), /Invalid smart mask points/);
    await assert.rejects(service.enqueue({ clip, asset, mask: f.mask, sourcePath: f.source, signature: 'old edits', direction: 'both', anchorTime: 0 }), /still saving/);
    assert.throws(() => validateSmartMaskBindings({ ...clip, smartMasks: [f.mask], effects: [{ id: 'effect', name: 'Smart Mask', enabled: true, amount: 100, maskId: 'missing' }] }, []), /missing smart mask/);
    assert.throws(() => validateSmartMaskBindings({ ...clip, smartMasks: [mask] }, []), /points/);
  } finally { await service.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('cancelling a running worker kills its decoder child process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameline-mask-cancel-')), marker = join(directory, 'child-finished');
  const controller = new AbortController();
  const childScript = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'),1200);setInterval(()=>{},1000)`;
  const parentScript = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'});console.log(JSON.stringify({progress:1}));setInterval(()=>{},1000)`;
  try {
    const work = runMaskProcess(process.execPath, ['-e', parentScript], controller.signal, () => controller.abort());
    await assert.rejects(work, /cancelled/);
    await delay(1400);
    assert.equal(existsSync(marker), false);
    await assert.rejects(runMaskProcess(process.execPath, ['-e', 'process.exit(0)'], AbortSignal.abort()), /cancelled/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('HTTP routes require editor writes and validate masks inside snapshots', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameline-mask-http-'));
  const app = createFrameLineServer({ dataDir: directory });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`;
  const request = async (cookie: string, path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
  };
  try {
    const owner = await request('', '/auth/signup', 'POST', { name: 'Mask Owner', email: 'mask-owner@example.test', password: 'strong-mask-password' });
    const viewer = await request('', '/auth/signup', 'POST', { name: 'Mask Viewer', email: 'mask-viewer@example.test', password: 'strong-mask-password' });
    const state = (await request(owner.cookie, '/state')).data;
    state.state.projects = [{ id: 'project', name: 'Masks', description: '', shared: true, classRole: 'Viewer', thumbnail: '', modifiedAt: 1, duration: 1, resolution: '64 × 32', fps: 2, status: 'In progress', members: [{ userId: owner.data.user.id, role: 'Owner' }] }];
    state.state.timelines = [{ id: 'timeline', projectId: 'project', name: 'Timeline', duration: 1 }];
    state.state.tracks = [{ id: 'track', timelineId: 'timeline', name: 'Video', kind: 'video', number: 1, muted: false, hidden: false, solo: false, locked: false, gain: 0, pan: 0 }];
    state.state.clips = [{ ...clip, timelineId: 'timeline', trackId: 'track', mediaId: 'frameline-shape', name: 'Shape', color: '#fff', disabled: false, properties: { shapeDocument: JSON.stringify(defaultShape()) } }];
    assert.equal((await request(owner.cookie, '/state', 'PUT', state)).status, 200);
    assert.equal((await request(viewer.cookie, '/smart-masks', 'POST', { clipId: 'clip', maskId: 'subject', direction: 'both', anchorTime: 0, signature: 'x' })).status, 403);
    assert.equal((await request(viewer.cookie, `/smart-masks/${'a'.repeat(64)}?projectId=project`, 'DELETE')).status, 403);
    assert.equal((await request(viewer.cookie, `/smart-masks/${'a'.repeat(64)}/manifest?projectId=private`)).status, 404);
    assert.equal((await request('', '/smart-masks/source?clipId=clip&frame=0')).status, 401);
    const current = (await request(owner.cookie, '/state')).data;
    const badMask = createSmartMask({ ...clip, mediaId: 'frameline-shape' }, { ...asset, id: 'frameline-shape' }, 'subject');
    badMask.prompts = [{ id: 'bad', kind: 'exclude', time: 0, radius: .01, points: [{ x: 2, y: .5 }] }];
    current.state.snapshots.push({ id: 'bad-snapshot', projectId: 'project', name: 'Invalid mask', note: '', userId: owner.data.user.id, timestamp: 1, state: { timelines: current.state.timelines, clips: [{ ...current.state.clips[0], smartMasks: [badMask] }], tracks: current.state.tracks, nodes: [], comments: [] } });
    const rejected = await request(owner.cookie, '/state', 'PUT', current);
    assert.equal(rejected.status, 400); assert.match(rejected.data.error, /smart mask points/);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('clip-bound manifest rejects changed input interpretation while historical downloads remain available', async () => {
  const f = fixture(), dataDir = join(f.directory, 'app');
  let app = createFrameLineServer({ dataDir }), base = '', cookie = '';
  const listen = async () => { await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api`; };
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  try {
    await listen();
    const signup = await request('/auth/signup', 'POST', { name: 'Mask Editor', email: 'mask-context@example.test', password: 'strong-mask-password' });
    cookie = signup.headers.get('set-cookie')!.split(';')[0];
    let state = (await request('/state')).data;
    state.state.projects = [{ id: 'project', name: 'Masks', description: '', shared: false, thumbnail: '', modifiedAt: 1, duration: 1, resolution: '64 × 32', fps: 2, status: 'In progress', members: [{ userId: signup.data.user.id, role: 'Owner' }] }];
    state.state.timelines = [{ id: 'timeline', projectId: 'project', name: 'Timeline', duration: 1 }];
    state.state.tracks = [{ id: 'track', timelineId: 'timeline', name: 'Video', kind: 'video', number: 1, muted: false, hidden: false, solo: false, locked: false, gain: 0, pan: 0 }];
    assert.equal((await request('/state', 'PUT', state)).status, 200);
    assert.equal((await request('/media?projectId=project&id=media&name=sample.mp4&placeholder=1', 'POST')).status, 201);
    state = (await request('/state')).data;
    state.state.clips = [{ ...clip, timelineId: 'timeline', trackId: 'track', name: 'Subject', color: '#fff', disabled: false, smartMasks: [f.mask] }];
    assert.equal((await request('/state', 'PUT', state)).status, 200);
    await app.close();
    const source = join(dataDir, 'media', 'media', 'original'), cache = join(dataDir, 'smart-masks'), root = join(cache, f.key);
    writeFileSync(source, 'immutable test source'); cpSync(f.root, root, { recursive: true });
    const binding = JSON.parse(readFileSync(join(root, 'binding.json'), 'utf8')); binding.sourceFingerprint = maskSourceFingerprint(source);
    writeFileSync(join(root, 'binding.json'), JSON.stringify(binding));
    writeFileSync(join(cache, `${f.key}.job.json`), JSON.stringify({ key: f.key, signature: f.signature, projectId: 'project', clipId: 'clip', maskId: 'subject', status: 'ready', progress: 100 }));
    app = createFrameLineServer({ dataDir }); await listen();
    const path = `/smart-masks/${f.key}/manifest?projectId=project`;
    const before = await request(`${path}&clipId=clip`);
    assert.equal(before.status, 200); assert.equal(before.headers.get('cache-control'), 'private, no-cache');
    state = (await request('/state')).data;
    state.state.clips[0].properties = { inputProfile: 'S-Log3', inputGamut: 'S-Gamut3.Cine' };
    assert.equal((await request('/state', 'PUT', state)).status, 200);
    const stale = await request(`${path}&clipId=clip`);
    assert.equal(stale.status, 409); assert.match(stale.data.error, /stale/);
    const historical = await request(path);
    assert.equal(historical.status, 200); assert.match(historical.headers.get('cache-control')!, /immutable/);
  } finally { await app.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
