// The shared-library jobs against a real SharedCut server on a temporary data folder: save a clip as a sound effect,
// find it, place it; upload a font; upload, favorite and delete an overlay; create, share, move and delete folders.
//   node --test mcp/jobs/assets.test.ts      (needs ffmpeg/ffprobe, like the server)
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createFrameLineServer } from '../../server/index.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'sharedcut-assets-'));
const app = createFrameLineServer({ dataDir });
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const signup = async (name: string, email: string) => (await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, email, password: 'assets test password' }) })).headers.get('set-cookie')!.split(';')[0];
const cookie = await signup('Asset Editor', 'assets@example.com');
await signup('Other Person', 'other@example.com');
process.env.FRAME_LINE_URL = url;
process.env.FRAME_LINE_COOKIE = cookie;
const { answer } = await import('../server.ts');

test.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await answer({ method: 'tools/call', params: { name, arguments: args } }) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map(c => c.text).join('\n'), error: !!result.isError };
}
const ok = async (name: string, args: Record<string, unknown> = {}) => { const r = await tool(name, args); assert.equal(r.error, false, r.text); return r.text; };
const job = (kind: string, params: Record<string, unknown> = {}, wait = 90) => ok('job', { kind, params, wait });
const state = async () => ((await (await fetch(`${url}/api/state`, { headers: { cookie } })).json()) as { state: any }).state;
const handleOf = (id: string) => '@' + /[0-9a-f]{8}-/.exec(id)![0].slice(0, 8);

/** One second of a 440 Hz tone, 16-bit mono WAV. */
function tone(seconds = 1, rate = 16000) {
  const n = seconds * rate, wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) wav.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 12000), 44 + i * 2);
  return wav;
}

let projectId = '';
test('save a clip as a sound effect, find it and place it on the timeline', async () => {
  await ok('act', { do: [['createProject', { name: 'Assets', description: '', shared: false }]] });
  projectId = (await state()).projects[0].id;
  const uploaded = await fetch(`${url}/api/media?projectId=${projectId}&name=tone.wav`, { method: 'POST', headers: { cookie }, body: tone() });
  assert.equal(uploaded.status < 300, true, await uploaded.text());
  let asset: any;
  for (let i = 0; i < 120 && asset?.status !== 'ready'; i++) { await new Promise(r => setTimeout(r, 250)); asset = (await state()).media[0]; }
  assert.equal(asset?.status, 'ready', JSON.stringify(asset));
  await ok('act', { do: [['addMediaToTimeline', handleOf(asset.id), 0]] });
  const source = (await state()).clips[0];

  assert.match(await job('sfx'), /library is empty/);
  const saved = await job('sfx-save', { clip: handleOf(source.id), name: 'Test Tone', category: 'Impacts', tags: 'beep, test' });
  const id = /saved (sfx-[0-9a-f]{8}) "Test Tone" · Impacts · 1s · beep,test/.exec(saved)?.[1];
  assert.ok(id, saved);
  assert.match(await job('sfx', { category: 'Impacts' }), new RegExp(`${id} "Test Tone"`));
  assert.match((await tool('job', { kind: 'sfx-add', params: { sound: 'nope' } })).text, /No sound "nope"/);

  const placed = await job('sfx-add', { sound: id, at: 3 });
  assert.match(placed, /"Test Tone" is media @[0-9a-f]{8}/);
  assert.match(placed, /\+ clip A\d @[0-9a-f]{8} 3–4 "Test Tone\.wav"/);
  const clips = (await state()).clips.filter((c: any) => c.mediaId.startsWith('media-sfx-'));
  assert.equal(clips.length, 1);
  assert.equal(clips[0].start, 3);
  // Overlapping the tone's own track, the next one goes to a free (new) audio track.
  await job('sfx-add', { sound: 'test tone', at: 3.5 });
  const now = await state(), two = now.clips.filter((c: any) => c.mediaId.startsWith('media-sfx-'));
  assert.equal(two.length, 2);
  assert.notEqual(two[0].trackId, two[1].trackId);
});

test('upload and list a shared font', async () => {
  const path = fileURLToPath(new URL('../../public/fonts/Montserrat.ttf', import.meta.url));
  const added = await job('font', { path, name: 'Montserrat Test' });
  const family = /fontFamily "(FL-[0-9a-f]{32})"/.exec(added)?.[1];
  assert.ok(family, added);
  assert.match(await job('fonts'), new RegExp(`${family} "Montserrat Test"\\nbundled: TikTok Sans`));
  assert.match((await tool('job', { kind: 'font', params: { path: join(tmpdir(), 'missing.ttf') } })).text, /No file at/);
  assert.match((await tool('job', { kind: 'font', params: { path: '/x/readme.txt' } })).text, /is not a TTF/);
});

test('upload, favorite and delete an overlay', async () => {
  const clipPath = join(dataDir, 'burn.mp4');
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=1', '-pix_fmt', 'yuv420p', '-y', clipPath]);
  assert.match(await job('overlay', { path: clipPath, name: 'Test Burn' }), /overlay test-burn "Test Burn" 1s → act addTransition/);
  assert.match(await job('overlays'), /test-burn "Test Burn" 1s \(yours\)/);
  await ok('act', { do: [['loadLeaks'], ['toggleTransitionFavorite', 'overlay:test-burn']] });
  assert.match(await job('overlays'), /test-burn "Test Burn" 1s ★ \(yours\)[\s\S]*favorites: overlay:test-burn/);
  // A delete names the overlay exactly: no prefix guesses.
  assert.match((await tool('job', { kind: 'overlay', params: { delete: 'test' } })).text, /No overlay "test"/);
  assert.match(await job('overlay', { delete: 'test-burn' }), /deleted overlay test-burn/);
  assert.match(await job('overlays'), /overlays: none/);
});

test('folders: create, share with confirmation, move a project in and out, delete', async () => {
  const created = await job('folder', { action: 'create', name: 'Week 1' });
  const folder = /created folder "Week 1" → (folder-[0-9a-f]{8})/.exec(created)?.[1];
  assert.ok(folder, created);
  const project = handleOf(projectId);
  assert.match(await job('folder', { action: 'move', id: project, parent: folder }), /moved "Assets" to "Week 1"/);
  assert.match(await job('folders'), new RegExp(`^${folder} "Week 1" \\(only you\\)\\n  ${project} "Assets"$`));
  assert.match(await job('folder', { action: 'update', id: folder, name: 'Week 2' }), /updated folder-[0-9a-f]{8} "Week 2"/);

  const asked = await job('folder', { action: 'update', id: 'Week 2', members: [{ user: 'Other Person', role: 'Viewer' }] });
  assert.match(asked, /Not done yet[\s\S]*gains Other Person[\s\S]*confirm:true/);
  assert.equal((await (await fetch(`${url}/api/library`, { headers: { cookie } })).json()).folders[0].members.length, 0);
  await job('folder', { action: 'update', id: folder, members: [{ user: 'Other Person', role: 'Viewer' }], confirm: true });
  assert.match(await job('folders'), /"Week 2" \(2 people\)/);

  assert.match((await tool('job', { kind: 'folder', params: { action: 'delete', id: folder } })).text, /Move the contents out/);
  await job('folder', { action: 'move', id: project, parent: null, confirm: true });
  assert.match(await job('folder', { action: 'delete', id: folder }), /permanently deletes/);
  assert.match(await job('folder', { action: 'delete', id: folder, confirm: true }), /deleted folder "Week 2"/);
  assert.equal(await job('folders'), `top level: ${project} "Assets"`);
});

test('text: new words and style on an animated title leave its animation keys alone', async () => {
  await ok('act', { at: 1, do: [['addTitle', 0]] });
  const title = (await state()).clips.find((c: any) => c.mediaId === 'frameline-title');
  const keys = JSON.stringify(title.keyframes);
  assert.match(await job('text', { clip: handleOf(title.id), text: 'BIG NEWS', style: { fontFamily: 'Montserrat', color: '#ffcc00' }, box: { outlineWidth: 3 } }), /"BIG NEWS" Montserrat/);
  const after = (await state()).clips.find((c: any) => c.id === title.id), doc = JSON.parse(after.properties.textDocument);
  assert.equal(JSON.stringify(after.keyframes), keys);
  assert.deepEqual([doc.runs.map((r: any) => r.text).join(''), doc.runs[0].style.color, doc.outlineWidth], ['BIG NEWS', '#ffcc00', 3]);
  // A look key in style would be saved into the runs and do nothing; it is refused with the right bucket named.
  assert.match((await tool('job', { kind: 'text', params: { clip: handleOf(title.id), style: { outlineWidth: 2 } } })).text, /style has no outlineWidth[\s\S]*box/);
  assert.match((await tool('job', { kind: 'text', params: { clip: handleOf((await state()).clips.find((c: any) => c.mediaId.startsWith('media-sfx-')).id) } })).text, /is not a title/);
});
