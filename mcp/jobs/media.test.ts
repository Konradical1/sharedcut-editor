// The media jobs against a fake SharedCut server (the demo workspace as the server copy). Link import cannot run on a
// Mac without the server's importer, so this walks its happy path: request like the editor's form -> new bin saved ->
// row moved into it once the server has it -> downloading -> processing -> ready; then pending{final} and cancel.
// Uploads, replace and download run live against a real server (see the module brief); localFiles is checked here.
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { useEditorStore as store, persistentState } from '../../src/state/store.ts';
import { applyStateDelta } from '../../src/services/stateDelta.ts';

process.env.FRAME_LINE_URL = 'http://fake.local';
process.env.FRAME_LINE_COOKIE = 'frameline_session=test';
let saved: any = structuredClone(persistentState(store.getState()));
let revision = 1;
const requests: { route: string; body?: any }[] = [];
const ID = 'media-3fa9c1d2-0000-4000-8000-000000000001';
const row = () => saved.media.find((m: any) => m.id === ID);
const change = (patch: Record<string, unknown>) => { saved = { ...saved, media: saved.media.map((m: any) => m.id === ID ? { ...m, ...patch } : m) }; revision++; };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
  const url = new URL(input), method = init.method ?? 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
  requests.push({ route: `${method} ${url.pathname}`, body });
  if (url.pathname === '/api/auth/me') return json({ user: saved.users.find((u: any) => u.id === saved.currentUserId) });
  if (url.pathname === '/api/state' && method === 'GET') return json(Number(url.searchParams.get('since')) === revision ? { revision } : { revision, state: saved });
  if (url.pathname === '/api/state' && method === 'PATCH') { saved = applyStateDelta(saved, body.delta); return json({ revision: ++revision }); }
  if (url.pathname === '/api/media/import-link') {
    const asset = { id: ID, projectId: body.projectId, name: 'YouTube · waiting to download', kind: 'video', binId: 'broll', thumbnail: '', duration: 0, resolution: '', fps: 0, size: '', status: 'downloading', progress: 0, importLink: { url: body.url, mode: body.mode, quality: body.quality } };
    saved = { ...saved, media: [asset, ...saved.media] }; revision++;
    return json({ asset }, 202);
  }
  if (url.pathname === '/api/media/move') { saved = { ...saved, media: saved.media.map((m: any) => body.mediaIds.includes(m.id) ? { ...m, binId: body.binId } : m) }; revision++; return json({ ok: true }); }
  if (/^\/api\/media\/[^/]+\/cancel$/.test(url.pathname)) { change({ status: 'failed', error: 'Import cancelled.' }); return json({ ok: true }); }
  return json({ error: 'API endpoint not found.' }, 404);
}) as typeof fetch;

const { ready } = await import('../edit.ts');
const { jobs, topics, localFiles } = await import('./media.ts');
const { isPoller } = await import('./kit.ts');
await ready();
store.getState().openProject('city-after-dark');
const projectId = store.getState().projectId;

test('link import: the form request, a new bin, then downloading -> processing -> ready', async () => {
  const started = await jobs.link.start({ url: 'https://youtu.be/dQw4w9WgXcQ', bin: 'Music' });
  assert.ok(isPoller(started));
  assert.deepEqual(requests.find(r => r.route === 'POST /api/media/import-link')?.body, { projectId, url: 'https://youtu.be/dQw4w9WgXcQ', mode: 'video', quality: 1080 });
  const bin = saved.projects.find((p: any) => p.id === projectId).bins.find((b: any) => b.name === 'Music');
  assert.ok(bin, 'the bin is saved before anything moves into it');

  let step = await started.poll();
  assert.equal(step.done, false);
  assert.match(step.text, /^Importing https:\/\/youtu\.be\/dQw4w9WgXcQ → bin Music\nWorking: 1 in progress\n@3fa9c1d2 YouTube · waiting to download downloading 0%$/);
  assert.deepEqual(requests.find(r => r.route === 'POST /api/media/move')?.body, { projectId, binId: bin.id, mediaIds: [ID] });
  assert.equal(row().binId, bin.id);

  change({ name: 'Song.mp4', status: 'processing', progress: 60, preparationStage: 'Creating playable preview' });
  step = await started.poll();
  assert.match(step.text, /@3fa9c1d2 Song\.mp4 processing 60% Creating playable preview$/);

  change({ status: 'ready', progress: 100, duration: 12.5, resolution: '1920×1080', fps: 25, preparationStage: 'Creating smaller playback previews' });
  step = await started.poll();
  assert.equal(step.done, true, 'ready is usable even while extra previews run');
  assert.match(step.text, /Done: 1 ready\n@3fa9c1d2 Song\.mp4 ready video 0:12\.50 1920×1080 25fps · Creating smaller playback previews$/);
  assert.equal(requests.filter(r => r.route === 'POST /api/media/move').length, 1, 'moved once');
});

test('pending{final} waits for the extra previews; nothing pending says so', async () => {
  const waiting = await jobs.pending.start({ media: [ID], final: true });
  assert.ok(isPoller(waiting));
  assert.equal((await waiting.poll()).done, false);
  change({ preparationStage: undefined });
  const step = await waiting.poll();
  assert.equal(step.done, true);
  assert.match(step.text, /@3fa9c1d2 Song\.mp4 ready video 0:12\.50 1920×1080 25fps$/);
  const none = await jobs.pending.start({});
  assert.ok(!isPoller(none) && /Nothing pending/.test(none.text));
});

test('cancelling a link import calls the editor\'s cancel and reports the row failed', async () => {
  saved = { ...saved, media: saved.media.filter((m: any) => m.id !== ID) }; revision++;
  const started = await jobs.link.start({ url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', quality: 720 });
  assert.ok(isPoller(started) && started.cancel);
  await started.cancel();
  assert.ok(requests.some(r => r.route === `POST /api/media/${ID}/cancel`));
  const step = await started.poll();
  assert.equal(step.done, true);
  assert.match(step.text, /@3fa9c1d2 YouTube · waiting to download failed: Import cancelled\.$/);
});

test('pending does not wait on an upload no transfer here is sending (an MCP restart, another editor)', async () => {
  saved = { ...saved, media: saved.media.map((m: any) => m.id === ID ? { ...m, status: 'uploading', progress: 37, error: undefined } : m) }; revision++;
  await ready(); // the job tool catches up before every job
  const step = await jobs.pending.start({});
  assert.ok(isPoller(step));
  const first = await step.poll();
  assert.equal(first.done, true);
  assert.match(first.text, /@3fa9c1d2 \S.* upload not running here \(37%\); upload the same file again to resume /);
});

test('localFiles: folders recurse, skip dot files and non-media, qualify shared names; a named file always goes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sharedcut-media-'));
  try {
    for (const [path, body] of [['a/C0001.MP4', 'x'], ['b/C0001.MP4', 'yy'], ['.cache/z.mp4', 'z'], ['notes.txt', 'n'], ['tone.wav', 'w']]) {
      await mkdir(join(dir, path, '..'), { recursive: true }); await writeFile(join(dir, path), body);
    }
    const found = await localFiles([dir, join(dir, 'notes.txt')]);
    assert.deepEqual(found.map(f => [f.name, f.size]), [['a · C0001.MP4', 1], ['b · C0001.MP4', 2], ['tone.wav', 1], ['notes.txt', 1]]);
    assert.ok(found.every(f => Number.isInteger(f.lastModified)), 'whole ms, so the upload fingerprint survives a restart');
    await assert.rejects(localFiles([join(dir, 'missing')]), /Nothing at/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('docs stay one line and the help topic leads with its header', () => {
  for (const [kind, job] of Object.entries(jobs)) assert.ok(!job.doc.includes('\n') && job.doc.length < 160, kind);
  assert.match(topics.media.split('\n')[0], /^media: /);
});
