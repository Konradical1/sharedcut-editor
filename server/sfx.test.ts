import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { soundLibrary } from './sfx.ts';
import { renderSoundEffect, probeMedia } from './media.ts';
import { soundFields, rankSounds, availableSoundTrack, type SoundEffect } from '../src/services/sfx.ts';
import { createFrameLineServer } from './index.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';

test('SFX metadata validation and hybrid search preserve exact matches and semantic-only matches', () => {
  assert.throws(() => soundFields({ name: '', category: 'New', tags: [], description: '' }));
  assert.throws(() => soundFields({ name: 'OK', category: 'New', tags: ['x'.repeat(41)], description: '' }));
  assert.deepEqual(soundFields({ name: ' Hit ', category: ' New ', tags: ['LOUD', 'loud'], description: '' }).tags, ['loud']);
  const sounds = [{ id: '1', name: 'Clock', category: 'Foley', tags: [], description: 'Time passing' }, { id: '2', name: 'Riser', category: 'Risers', tags: [], description: 'Tension building' }] as unknown as SoundEffect[];
  assert.equal(rankSounds(sounds, 'Clock', [.3, .8])[0].id, '1');
  assert.deepEqual(rankSounds(sounds, 'suspense', [.1, .7]).map(s => s.id), ['2']);
  assert.equal(rankSounds(sounds, 'nonsense', [.1, .1]).length, 0);
  const tracks = [{ id: 'a', timelineId: 'tl', kind: 'audio', number: 1 }, { id: 'b', timelineId: 'tl', kind: 'audio', number: 2 }] as Track[];
  const occupied = [{ trackId: 'a', start: 0, duration: 2 }] as Clip[];
  assert.equal(availableSoundTrack(tracks, occupied, 'tl', 0, 1)?.id, 'b');
  assert.equal(availableSoundTrack(tracks, occupied, 'tl', 2, 1)?.id, 'a');
  assert.equal(availableSoundTrack(tracks.map(t => ({ ...t, locked: true })), [], 'tl', 0, 1), undefined);
});

test('saved SFX retains trim, speed, gain, pan, fades and independent project media; routes require authorization', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frameline-sfx-test-'));
  let app: ReturnType<typeof createFrameLineServer> | undefined;
  try {
    const source = join(dir, 'source.wav'), output = join(dir, 'trim.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', String.raw`aevalsrc=if(lt(t\,1)\,0\,0.2*sin(2*PI*440*t)):s=48000:d=4`, '-c:a', 'pcm_s24le', source]);
    const project = { id: 'p', fps: 24, resolution: '1920 × 1080' } as Project;
    const track = { id: 't', timelineId: 'tl', name: 'Audio', kind: 'audio', gain: -30, pan: -100, muted: true, solo: false, number: 1 } as Track;
    const clip: Clip = { id: 'c', projectId: 'p', timelineId: 'tl', trackId: 't', mediaId: 'm', name: 'Trim', start: 2, sourceIn: 1, duration: 1, color: '', disabled: false, effects: [], properties: { speed: 200, gain: -6, pan: 100, audioFadeIn: .2, audioFadeOut: .2 } };
    const asset = { id: 'm', projectId: 'p', name: 'Source.wav', kind: 'audio', duration: 4, fps: 0, hasAudio: true } as MediaAsset;
    await renderSoundEffect({ project, track, clip, asset, inputPath: source, outputPath: output });
    assert.ok(Math.abs((await probeMedia(output)).duration - 1) < .001);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', output, '-f', 'f32le', '-ac', '2', 'pipe:1']);
    const rms = (channel: number, from: number, to: number) => { let sum = 0, count = 0; for (let i = Math.floor(from * 48000); i < Math.floor(to * 48000); i++) { sum += pcm.readFloatLE(i * 8 + channel * 4) ** 2; count++; } return Math.sqrt(sum / count); };
    assert.ok(rms(0, .4, .6) < .00001, 'Hard-right pan removes left channel');
    assert.ok(rms(1, .4, .6) > .045 && rms(1, .4, .6) < .11, 'Clip gain retained; track mute/gain excluded');
    assert.ok(rms(1, 0, .03) < rms(1, .4, .6) / 3, 'Fade in retained');
    assert.ok(rms(1, .97, 1) < rms(1, .4, .6) / 3, 'Fade out retained');
    const animated = join(dir, 'animated.wav');
    await renderSoundEffect({ project, track, clip: { ...clip, duration: .5, properties: { speed: 100 }, keyframes: { 'properties.gain': [{ id: 'quiet', time: 0, value: -30, interpolation: 'linear' }, { id: 'loud', time: .45, value: 0, interpolation: 'linear' }] } }, asset, inputPath: source, outputPath: animated });
    const automation = execFileSync('ffmpeg', ['-v', 'error', '-i', animated, '-ac', '1', '-f', 'f32le', 'pipe:1']);
    const energy = (from: number, to: number) => { let sum = 0; for (let i = Math.floor(from * 48000); i < Math.floor(to * 48000); i++) sum += automation.readFloatLE(i * 4) ** 2; return sum; };
    assert.ok(energy(.4, .45) > energy(.05, .1) * 10, 'Clip gain keyframes survive saving');
    const library = soundLibrary(dir);
    const sound = await library.add(output, { name: 'Right Hit', category: 'My Custom Category', tags: ['impact'], description: 'A quick accent' });
    const imported = library.importAsset(sound.id, 'p', 'copy', join(dir, 'media', 'copy'));
    assert.equal(imported.duration, 1);
    assert.deepEqual(await readFile(join(dir, 'media', 'copy', 'original')), await readFile(output));
    await rm(source); await rm(output);
    assert.equal((await library.search('', '')).sounds.length, 1);
    const stale = library.reserve({ name: 'Interrupted', category: 'Test', tags: [], description: '' }); library.recover();
    assert.equal(library.get(stale.id)?.status, 'failed');
    app = createFrameLineServer({ dataDir: dir }); await new Promise<void>(r => app!.server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    assert.equal((await fetch(`${url}/api/sfx`)).status, 401);
    const signup = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Sound Editor', email: 'sfx@example.test', password: 'test sound password' }) });
    assert.equal(signup.status, 201); const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await fetch(`${url}/api/sfx/${sound.id}/preview`)).status, 401);
    const preview = await fetch(`${url}/api/sfx/${sound.id}/preview`, { headers: { cookie, range: 'bytes=0-31' } }); assert.equal(preview.status, 206); assert.equal((await preview.arrayBuffer()).byteLength, 32);
    const catalog = await (await fetch(`${url}/api/sfx`, { headers: { cookie } })).json(); assert.ok(catalog.categories.includes('My Custom Category'));
    const bob = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Viewer', email: 'viewer@example.test', password: 'test viewer password' }) });
    const bobId = (await bob.json()).user.id, bobCookie = bob.headers.get('set-cookie')!.split(';')[0];
    const shared = await (await fetch(`${url}/api/sfx`, { headers: { cookie: bobCookie } })).json(); assert.ok(shared.sounds.some((s: SoundEffect) => s.id === sound.id), 'Catalog is visible across accounts');
    const snapshot = await (await fetch(`${url}/api/state`, { headers: { cookie } })).json();
    snapshot.state.projects.push({ id: 'owned', name: 'Owned', description: '', shared: true, classRole: 'Viewer', thumbnail: '', modifiedAt: Date.now(), duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: snapshot.state.currentUserId, role: 'Owner' }, { userId: bobId, role: 'Viewer' }] });
    const saved = await fetch(`${url}/api/state`, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(snapshot) }); assert.equal(saved.status, 200, await saved.text());
    for (const route of [`/sfx/${sound.id}/import`, '/sfx']) {
      const response = await fetch(`${url}/api${route}`, { method: 'POST', headers: { cookie: bobCookie, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'owned' }) }); assert.equal(response.status, 403, 'Viewers cannot save or insert sounds');
    }
    const forbidden = await fetch(`${url}/api/sfx/${sound.id}/import`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'private-project' }) }); assert.equal(forbidden.status, 404);
  } finally { await app?.close(); await rm(dir, { recursive: true, force: true }); }
});
