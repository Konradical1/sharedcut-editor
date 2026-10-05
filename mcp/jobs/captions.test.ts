// Captions through the MCP against a real SharedCut server on a temporary data folder. The speech worker is not
// installed in tests, so /api/captions* is answered by a fake that walks the server's job states; everything else
// (the install through installCaptions, the save and its validation) is the real thing.
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFrameLineServer } from '../../server/index.ts';
import { groupCaptionWords, type CaptionJob, type CaptionWord } from '../../src/services/captions.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'sharedcut-captions-'));
process.env.FRAME_LINE_CAPTION_PYTHON = join(dataDir, 'no-speech-worker'); // the real server must say "not installed"
const app = createFrameLineServer({ dataDir });
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const signup = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Captioner', email: 'cap@example.com', password: 'caption test password' }) });
const cookie = signup.headers.get('set-cookie')!.split(';')[0];
process.env.FRAME_LINE_URL = url;
process.env.FRAME_LINE_COOKIE = cookie;

const spoken: CaptionWord[] = [['Hello', .2, .6], ['there.', .65, 1], ['This', 1.3, 1.5], ['is', 1.55, 1.7], ['a', 1.75, 1.8], ['caption', 1.85, 2.3], ['test', 2.35, 2.8]]
  .map(([text, start, end]) => ({ text: text as string, start: start as number, end: end as number, ...(text === 'caption' ? { uncertain: true } : {}) }));
const fake = { live: false, hold: false, blip: false, jobs: new Map<string, CaptionJob>(), posts: [] as any[], deletes: [] as string[] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const real = globalThis.fetch;
// Installed before the MCP's own fetch wrapper, which forwards to whatever fetch it finds.
globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, { pathname } = new URL(href, url);
  if (fake.live || !pathname.startsWith('/api/captions')) return real(input, init);
  const method = init.method ?? 'GET', id = pathname.split('/')[3];
  if (!id && method === 'GET') return json({ available: true, jobs: [...fake.jobs.values()].reverse().map(({ words, ...job }) => job) });
  if (!id && method === 'POST') {
    const body = JSON.parse(String(init.body));
    fake.posts.push(body);
    const job: CaptionJob = { wordsPerLine: body.wordsPerLine, preset: body.preset, removeSets: body.removeSets, ...(body.replaceSet ? { replaceSet: body.replaceSet } : {}), id: `caption-${randomUUID()}`, projectId: body.projectId, timelineId: body.timelineId, start: body.start, end: body.end, trackIds: body.trackIds, signature: body.signature, status: 'waiting', stage: 'Queued', progress: 0 };
    fake.jobs.set(job.id, job);
    return json({ job }, 202);
  }
  if (fake.blip) { fake.blip = false; return json({ error: 'Bad gateway' }, 502); }
  const job = fake.jobs.get(id);
  if (!job) return json({ error: 'Transcription not found.' }, 404);
  if (method === 'DELETE') { fake.deletes.push(id); Object.assign(job, { status: 'cancelled', stage: 'Cancelled' }); return json({ ok: true }); }
  // Each look moves the job on: queued → transcribing → done, words in timeline seconds like the server's.
  if (fake.hold) { /* the job sits where it is */ }
  else if (job.status === 'waiting') Object.assign(job, { status: 'running', stage: 'Transcribing · 1 / 2 passages', progress: 40 });
  else if (job.status === 'running') Object.assign(job, { status: 'complete', stage: 'Ready', progress: 100, words: spoken.map(w => ({ ...w, start: w.start + job.start, end: Math.min(job.end, w.end + job.start) })) });
  return json({ job });
}) as typeof fetch;

const { answer } = await import('../server.ts');
test.after(async () => { globalThis.fetch = real; await app.close(); await rm(dataDir, { recursive: true, force: true }); });

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await answer({ method: 'tools/call', params: { name, arguments: args } }) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: result.content.map(c => c.text).join('\n'), error: !!result.isError };
}
const ok = async (name: string, args: Record<string, unknown> = {}) => { const r = await tool(name, args); assert.equal(r.error, false, r.text); return r.text; };
const job = (kind: string, params: Record<string, unknown> = {}, wait?: number) => tool('job', { kind, params, ...(wait === undefined ? {} : { wait }) });
const server = async () => (await (await real(`${url}/api/state`, { headers: { cookie } })).json()).state as any;
const handleOf = (id: string) => '@' + /[0-9a-f]{8}-/.exec(id)![0].slice(0, 8);
const pollId = (text: string) => /id:"(j\d+)"/.exec(text)![1];

test('captions: refusal, generate → poll → install, list, style, subtitles, replace guard, cancel', async () => {
  await ok('act', { do: [['createProject', { name: 'Captions', description: '', shared: false }]] });
  await ok('act', { at: 0, do: [['addTitle', 0]] });

  // The real server without a speech worker: its own words come back.
  fake.live = true;
  const refused = await job('captions');
  assert.equal(refused.error, true);
  assert.match(refused.text, /speech models are not installed/);
  fake.live = false;
  assert.match((await job('captions', { preset: 'nope' })).text, /Unknown caption preset "nope". Presets: movie, /);

  const started = await job('captions', { wordsPerLine: 3, preset: 'movie' }, 0);
  assert.match(started.text, /captions job [0-9a-f]{8}: Transcribing · 1 \/ 2 passages 40%/);
  let s = await server();
  const title = s.clips[0], post = fake.posts[0];
  assert.deepEqual({ ...post, signature: typeof post.signature }, { projectId: s.projects[0].id, timelineId: title.timelineId, start: 0, end: title.start + title.duration, trackIds: [], wordsPerLine: 3, preset: 'movie', removeSets: [], signature: 'string' });

  const finished = await ok('job', { kind: 'status', id: pollId(started.text) });
  assert.match(finished, /Captions set @[0-9a-f]{8} on track @[\w-]+: 3 lines, 7 words \(1 uncertain timings\), 0–5s, 3 words\/line, movie\./);
  s = await server();
  const track = s.tracks.find((t: any) => t.captionSets?.length), set = track.captionSets[0];
  const lines = () => s.clips.filter((c: any) => c.properties.captionSet === set.id);
  assert.equal(lines().length, groupCaptionWords(spoken, 3).length);
  assert.deepEqual([set.preset, set.wordsPerLine, track.muted], ['movie', 3, true]);

  assert.match(await ok('job', { kind: 'caption-sets', params: {} }), new RegExp(`captions available[^]*set ${handleOf(set.id)} 0–5s · 3 lines · 3 words/line · movie$`, 'm'));
  assert.match((await job('captions')).text, /overlaps 0–5s\. Pass overlap:"keep"/);
  assert.match((await job('captions', { job: 'beef' })).text, /No caption job "beef"/);

  assert.match(await ok('job', { kind: 'caption-style', params: { set: handleOf(set.id), preset: 'highlight', color: '#ffee00', size: 90, accent: '#00ff00', wordPop: true } }), /3 caption lines restyled \(preset, color, size, accent, wordPop\)/);
  s = await server();
  for (const line of lines()) {
    const doc = JSON.parse(line.properties.textDocument);
    assert.deepEqual([doc.caption.preset, doc.runs[0].style.color, doc.runs[0].style.fontSize, doc.caption.accent, doc.caption.wordPop], ['highlight', '#ffee00', 90, '#00ff00', true]);
  }
  assert.equal(s.tracks.find((t: any) => t.id === track.id).captionSets[0].preset, 'highlight');
  assert.match((await job('caption-style', { set: handleOf(set.id), font: 'Comic Sans' })).text, /would not export\. Use one of: TikTok Sans, Montserrat, Barlow Condensed/);

  const srt = await ok('job', { kind: 'subtitles', params: { path: join(dataDir, 'out', 'subs') } });
  assert.match(srt, /Wrote 3 cues \(0–5s\) to .*subs\.srt$/);
  assert.match(await readFile(join(dataDir, 'out', 'subs.srt'), 'utf8'), /^1\n00:00:00,200 --> 00:00:01,120\nHello there\.\n\n2\n/);
  await ok('job', { kind: 'subtitles', params: { path: join(dataDir, 'out', 'subs.vtt'), start: 1 } });
  assert.match(await ok('job', { kind: 'subtitles', params: { path: join(dataDir, 'out'), format: 'vtt' } }), /Wrote 3 cues .* to .*out[\\/][^\\/]+\.vtt$/);
  assert.match(await readFile(join(dataDir, 'out', 'subs.vtt'), 'utf8'), /^WEBVTT\n\n00:00:00\.000 --> 00:00:00\.120\nHello there\.\n\n00:00:00\.300 --> /);

  // Regenerating while someone edits the lines it would replace: the ready transcript waits for an explicit install.
  const again = await job('captions', { replace: handleOf(set.id) }, 0);
  assert.deepEqual([fake.posts[1].replaceSet, fake.posts[1].wordsPerLine, fake.posts[1].preset], [set.id, 3, 'highlight']);
  const first = lines()[0], words = JSON.parse(first.properties.textDocument).caption.words;
  await ok('act', { do: [['updateCaption', handleOf(first.id), words.map((w: CaptionWord, i: number) => i ? w : { ...w, text: 'Hi' })]] });
  const guarded = await ok('job', { kind: 'status', id: pollId(again.text) });
  assert.match(guarded, /edited while it ran, so nothing was replaced\. Replace them anyway: job captions\{job:"([0-9a-f]{8})"\}/);
  const short = /job:"([0-9a-f]{8})"/.exec(guarded)![1];
  s = await server();
  assert.ok(s.clips.some((c: any) => c.id === first.id), 'the edited lines stay');
  assert.match(await ok('job', { kind: 'captions', params: { job: short } }), /Captions set .* replaced 1 set\./);
  s = await server();
  assert.ok(!s.clips.some((c: any) => c.id === first.id));
  assert.equal(s.tracks.find((t: any) => t.id === track.id).captionSets[0].id, set.id, 'a regenerated set keeps its id');
  assert.match(await ok('job', { kind: 'captions', params: { job: short } }), /already on the timeline as set/);

  // Cancel reaches the server only while the job runs: one that finished meanwhile stays installable.
  const finishing = await job('captions', { overlap: 'keep', start: 1, end: 2 }, 0);
  await ok('job', { kind: 'cancel', params: { id: pollId(finishing.text) } });
  assert.deepEqual(fake.deletes, []);
  fake.hold = true; fake.blip = true;
  const running = await job('captions', { overlap: 'keep', start: 1, end: 2 }, 0);
  assert.match(running.text, /server unreachable, retrying/);
  assert.match(await ok('job', { kind: 'cancel', params: { id: pollId(running.text) } }), /Cancelled captions/);
  assert.deepEqual(fake.deletes, [[...fake.jobs.keys()][3]]);
  fake.hold = false;
});
