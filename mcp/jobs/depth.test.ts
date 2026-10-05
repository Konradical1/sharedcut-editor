// The depth jobs against a real SharedCut server in-process. Only /api/depth* is answered by a fake: the analysis
// needs the Python worker (npm run setup:depth), which a dev Mac may not have. The fake walks a run through
// failed → retried, cancelled, a gateway timeout, queued → processing → ready, and serves a preview segment encoded
// the way scripts/depth.py encodes it, so depth-probe decodes a real file with the real ffmpeg.
//   node --test mcp/jobs/depth.test.ts
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createFrameLineServer } from '../../server/index.ts';
import type { DepthRun } from '../../src/services/depth.ts';

const exec = promisify(execFile), ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const dir = await mkdtemp(join(tmpdir(), 'sharedcut-mcp-depth-'));
const app = createFrameLineServer({ dataDir: join(dir, 'data') });
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const signup = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Depth', email: 'depth@example.com', password: 'depth test password' }) });
const cookie = signup.headers.get('set-cookie')!.split(';')[0];
process.env.FRAME_LINE_URL = url;
process.env.FRAME_LINE_COOKIE = cookie;

// A 16x8 preview segment of 60 frames: left half stored depth 200, right half 3 x frame number (scripts/depth.py's flags, lossless).
const segment = join(dir, 'seg.mp4');
await new Promise<void>((resolve, reject) => {
  const encoder = spawn(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-s', '16x8', '-r', '30', '-pix_fmt', 'yuvj420p', '-color_range', 'pc', '-i', 'pipe:0', '-c:v', 'libx264', '-qp', '0', '-color_range', 'pc', '-movflags', '+faststart', '-f', 'mp4', segment]);
  encoder.on('error', reject).on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
  for (let n = 0; n < 60; n++) { const frame = Buffer.alloc(16 * 8 * 1.5, 128); for (let i = 0; i < 128; i++) frame[i] = i % 16 < 8 ? 200 : 3 * n; encoder.stdin.write(frame); }
  encoder.stdin.end();
});

// The fake depth service. POST and GET answers are taken from these queues; the last GET answer repeats.
const KEY = 'a'.repeat(64);
const view = (extra: Partial<DepthRun>): DepthRun => ({ key: KEY, status: 'queued', progress: 0, mediaId: '', first: 0, frames: 90, times: Array.from({ length: 90 }, (_, i) => i / 30), width: 16, height: 8, lo: 0, hi: 1, near: .9, far: .1, segments: [], next: 0, ...extra });
const calls: string[] = [];
let caps: Record<string, unknown> = { available: false, reason: 'Depth is not installed on this server. Run npm run setup:depth.' };
let posts: (DepthRun | number)[] = [], gets: DepthRun[] = [], evicted = false;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const real = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const target = new URL(input instanceof Request ? input.url : String(input), url), method = init.method ?? 'GET';
  if (!target.pathname.startsWith('/api/depth')) return real(input, init);
  calls.push(`${method} ${target.pathname}${target.search}`);
  if (target.pathname === '/api/depth/capabilities') return json(caps);
  if (target.pathname === '/api/depth' && method === 'POST') {
    const next = posts.length > 1 ? posts.shift()! : posts[0];
    // A tunnel's gateway timeout: an HTML page, not JSON.
    return typeof next === 'number' ? new Response('<html>timeout</html>', { status: next }) : json({ ...next, times: view({}).times }, next.status === 'ready' ? 200 : 202);
  }
  if (target.pathname.endsWith('/preview/0.mp4')) return evicted ? json({ error: 'Depth segment not found.' }, 404) : new Response(await readFile(segment), { headers: { 'content-type': 'video/mp4' } });
  if (method === 'DELETE') return json({ ok: true });
  return json({ ...(gets.length > 1 ? gets.shift()! : gets[0]), times: [] });
}) as typeof fetch;

const { answer } = await import('../server.ts');
test.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await answer({ method: 'tools/call', params: { name, arguments: args } }) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map(c => c.text).join('\n'), error: !!result.isError };
}
const ok = async (name: string, args: Record<string, unknown> = {}) => { const r = await tool(name, args); assert.equal(r.error, false, r.text); return r.text; };
const fails = async (name: string, args: Record<string, unknown>, pattern: RegExp) => { const r = await tool(name, args); assert.equal(r.error, true, r.text); assert.match(r.text, pattern); };
const saved = async () => (await (await real(`${url}/api/state`, { headers: { cookie } })).json()).state;
const handleOf = (id: string) => '@' + /[0-9a-f]{8}-/.exec(id)![0].slice(0, 8);

test('depth analysis: refusals, a failure and its retry, cancel, a gateway timeout, then ready; probe sets focus', async () => {
  await ok('act', { do: [['createProject', { name: 'Depth', description: '', shared: false }]] });
  const project = (await saved()).projects[0];
  const clipFile = join(dir, 'clip.mp4');
  await exec(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30', '-t', '3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clipFile]);
  const upload = await real(`${url}/api/media?projectId=${project.id}&name=clip.mp4`, { method: 'POST', headers: { cookie }, body: await readFile(clipFile) });
  const mediaId = (await upload.json()).asset.id;
  for (let i = 0; i < 300 && (await saved()).media.find((m: any) => m.id === mediaId).status !== 'ready'; i++) await new Promise(r => setTimeout(r, 100));
  await ok('act', { do: [['addMediaToTimeline', handleOf(mediaId), 0]] });
  const clip = (await saved()).clips.find((c: any) => c.mediaId === mediaId && c.trackId.endsWith('-v1')), h = handleOf(clip.id);

  await fails('job', { kind: 'depth', params: { clip: h } }, /no Depth effect or depth key/);
  await ok('act', { do: [['addEffect', h, 'Depth']] });
  await fails('job', { kind: 'depth', params: { clip: h } }, /not installed on this server/);

  caps = { available: true, engine: 'vda-small', device: 'cuda' };
  posts = [view({ status: 'failed', error: 'The server restarted. Click Retry.' })];
  await fails('job', { kind: 'depth', params: { clip: h } }, /Depth failed on @\w+: The server restarted\. job depth\{clip:"@\w+"\} again retries/);

  // Asked again it retries, and a cancel stops the watch and frees the server's queue.
  posts = [view({ status: 'queued' })]; gets = [view({ status: 'queued' })];
  const running = await ok('job', { kind: 'depth', wait: 0, params: { clip: h } });
  const id = /id:"(j\d+)"/.exec(running)![1];
  await new Promise(r => setTimeout(r, 150));
  assert.match(await ok('job', { kind: 'cancel', params: { id } }), /Cancelled depth/);
  assert.ok(calls.includes(`DELETE /api/depth/${KEY}?projectId=${project.id}`), calls.join('\n'));

  // A gateway timeout on the first ask is asked again; a run someone else cancelled is asked again too (not a failure);
  // then the run is polled with ?after and no times until ready.
  const before = calls.filter(c => c.startsWith('POST')).length;
  posts = [524, view({ status: 'queued' })];
  gets = [view({ status: 'cancelled', error: 'Cancelled.' }), view({ status: 'processing', progress: 50, segments: [{ n: 0, first: 0, count: 64 }], next: 1 }), view({ status: 'ready', progress: 100, segments: [{ n: 1, first: 64, count: 26 }], next: 2, telemetry: { frames: 90, seconds: 3, fps: 30, analysisFps: 31.4, device: 'cuda' } })];
  assert.match(await ok('job', { kind: 'depth', params: { clip: h } }), /^@\w+ depth ready · 90f 16x8 · 31fps cuda$/);
  assert.equal(calls.filter(c => c.startsWith('POST')).length - before, 3, 'the 524 and the cancelled run were asked again');
  assert.ok(calls.includes(`GET /api/depth/${KEY}?projectId=${project.id}&after=1&times=0`), calls.join('\n'));

  // Probe: frame 15 (0.51 s into the clip) of segment 0; distance = (near - byte/255) / (near - far) x 100.
  assert.match(await ok('job', { kind: 'depth-probe', params: { clip: h, x: .25, y: .5, at: .51 } }), /distance 14 at \(0\.25, 0\.5\) t=0\.51s$/);
  assert.match(await ok('job', { kind: 'depth-probe', params: { clip: h, x: .75, y: .5, at: .51, focus: true } }), /distance 90 .* · focus set/);
  assert.equal((await saved()).clips.find((c: any) => c.id === clip.id).effects.find((e: any) => e.name === 'Depth').parameters.focus, 90);
  await fails('job', { kind: 'depth-probe', params: { clip: h, x: .5, y: .5, at: 5 } }, /not at 5 s/);
  // The server evicted the ready run: the probe asks for it again (the viewer's rerun) and says so; then it probes again.
  evicted = true;
  const asked = calls.filter(c => c.startsWith('POST')).length;
  posts = [view({ status: 'ready', progress: 100, segments: [{ n: 0, first: 0, count: 64 }, { n: 1, first: 64, count: 26 }], next: 2 })];
  await fails('job', { kind: 'depth-probe', params: { clip: h, x: .25, y: .5, at: .51 } }, /gone from the server; it is running again/);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(calls.filter(c => c.startsWith('POST')).length - asked, 1, 'the evicted run was asked again');
  evicted = false;
  assert.match(await ok('job', { kind: 'depth-probe', params: { clip: h, x: .25, y: .5, at: .51 } }), /distance 14 /);
  const own = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = join(dir, 'no-ffmpeg');
  try { await fails('job', { kind: 'depth-probe', params: { clip: h, x: .5, y: .5, at: .51 } }, /needs ffmpeg/); } finally { if (own === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = own; }
});
