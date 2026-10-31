// The frame tool and the levels job against a real SharedCut server on a temporary data folder, with FFmpeg-made media:
// a graded clip under a title, a contact sheet, a clip's ungraded source, Stabilize falling back to the source, an
// old server (no /api/frames) falling back to the thumbnail, and the sound of a clipping clip with a gap.
import '../env.ts';
import { GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
// These tests check pixels and exports, not the host's optional system fonts.
GlobalFonts.registerFromPath(fileURLToPath(new URL('../../public/fonts/TikTokSans.ttf', import.meta.url)), 'Helvetica Neue');
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFrameLineServer } from '../../server/index.ts';
import { run } from '../../server/media.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'sharedcut-mcp-visual-'));
const app = createFrameLineServer({ dataDir });
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const signup = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Visual', email: 'visual@example.com', password: 'visual test password' }) });
const cookie = signup.headers.get('set-cookie')!.split(';')[0];
process.env.FRAME_LINE_URL = url;
process.env.FRAME_LINE_COOKIE = cookie;
const { answer } = await import('../server.ts');

test.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

type Part = { type: string; text?: string; data?: string };
async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await answer({ method: 'tools/call', params: { name, arguments: args } }) as { content: Part[]; isError?: boolean };
  assert.equal(result.isError, undefined, result.content.map(c => c.text).join('\n'));
  return { text: result.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), images: result.content.filter(c => c.type === 'image').map(c => Buffer.from(c.data!, 'base64')) };
}
const state = async () => (await (await fetch(`${url}/api/state`, { headers: { cookie } })).json()).state as any;
const pixel = async (jpeg: Buffer, x: number, y: number) => {
  const file = join(dataDir, 'probe.jpg'); await import('node:fs/promises').then(fs => fs.writeFile(file, jpeg));
  return [...await run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=2:2:${x}:${y}`, '-pix_fmt', 'rgb24', '-frames:v', '1', '-f', 'rawvideo', 'pipe:1'], { binary: true })].slice(0, 3);
};
const grey = (p: number[]) => Math.max(...p) - Math.min(...p) < 20;

test('frames show the graded, titled edit; sheets, sources and fallbacks say what they show; levels reads the sound', { timeout: 120_000 }, async () => {
  await tool('act', { do: [['createProject', { name: 'Frames', description: '', shared: false }]] });
  const project = (await state()).projects[0];
  // Red with a loud (clipping) tone, silent from 2 s to 3.2 s.
  const file = join(dataDir, 'red.mp4');
  await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xc82828:s=320x180:r=24:d=5', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,3.2),0,1.2*sin(2*PI*220*t))':d=5:s=48000", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const upload = await fetch(`${url}/api/media?projectId=${encodeURIComponent(project.id)}&name=red.mp4`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: await readFile(file) });
  const mediaId = (await upload.json()).asset.id as string;
  for (let i = 0; i < 300 && (await state()).media.find((m: any) => m.id === mediaId)?.status !== 'ready'; i++) await new Promise(r => setTimeout(r, 200));
  const placed = await tool('act', { do: [['addMediaToTimeline', mediaId, 0]] });
  const s = await state(), video = s.clips.find((c: any) => c.mediaId === mediaId && s.tracks.find((t: any) => t.id === c.trackId)?.kind === 'video');
  const v3 = s.tracks.find((t: any) => t.timelineId === video.timelineId && t.kind === 'video' && t.number === 3);
  await tool('act', { select: [video.id], do: [['addNode', 'Mono', { saturation: 0 }], ['addTitle', 0, {}, { start: 0, trackId: v3.id }, false]] });
  assert.match(placed.text, /red\.mp4/);

  const final = await tool('frame', { time: 1, width: 320 });
  assert.match(final.text, /00:00:01:00 \(1s\) final picture/);
  assert.deepEqual([...final.images[0].subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.ok(grey(await pixel(final.images[0], 20, 20)), 'the grade is in the final picture');

  const source = await tool('frame', { clip: video.id, time: 1, width: 320 });
  assert.match(source.text, /^@[0-9a-f]{8} "red\.mp4" 00:00:01:00 \(1s\) source "red\.mp4" @1s, ungraded$/);
  const red = await pixel(source.images[0], 20, 20);
  assert.ok(red[0] > 150 && red[2] < 90, `the source is not graded: ${red}`);

  const sheet = await tool('frame', { n: 4 });
  assert.match(sheet.text, /4 frames 0–4\.958s, 2×2 of 256×144/);
  assert.equal(sheet.images.length, 1, 'one picture for the whole sheet');

  // A title over a composition: the composition's inside (graded), not the clip under the composition.
  await tool('act', { select: [video.id], do: [['createComposition', 'Inner']] });
  const nested = await tool('frame', { time: 1, width: 320 });
  assert.match(nested.text, /inside composition "Inner" @1s \(overlays above it not drawn\)/);
  assert.ok(grey(await pixel(nested.images[0], 20, 20)), 'the grade inside the composition is drawn');
  await tool('act', { do: [['undo']] });

  // Stabilize bakes the whole clip: the still falls back to the clip's source, and says so.
  await tool('act', { do: [['addEffect', video.id, 'Stabilize']] });
  const live = await tool('frame', { time: 1, width: 320 });
  assert.match(live.text, /Stabilize\/optical flow renders only in editor\/Export; @[0-9a-f]{8} source "red\.mp4"/);

  // An older server without /api/frames: the clip's thumbnail, labelled.
  const installed = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: RequestInit) => typeof input === 'string' && input.startsWith('/api/frames') ? Promise.resolve(new Response(JSON.stringify({ error: 'API endpoint not found.' }), { status: 404, headers: { 'content-type': 'application/json' } })) : installed(input, init)) as typeof fetch;
  try {
    const old = await tool('frame', { time: 1 });
    assert.match(old.text, /thumbnail of "red\.mp4" \(server has no \/api\/frames; update it\)/);
    assert.deepEqual([...old.images[0].subarray(0, 3)], [0xff, 0xd8, 0xff]);
  } finally { globalThis.fetch = installed; }

  const levels = await tool('job', { kind: 'levels', params: { bars: 16 } });
  assert.match(levels.text, /^A1 @[0-9a-f]{8} "red\.mp4" 0–5 pk \+0dB -?\d+(\.\d)?LUFS [ ▁-█]{16} CLIP$/m);
  assert.match(levels.text, /silence 2\.0\d*–3\.2\d*/, levels.text);
  // Asked for the video clip, levels reports the linked audio copy its sound plays from.
  assert.match((await tool('job', { kind: 'levels', params: { clip: video.id } })).text, /^A1 @[0-9a-f]{8} "red\.mp4"/);
});
