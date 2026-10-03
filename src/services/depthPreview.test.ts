import test from 'node:test';
import assert from 'node:assert/strict';
import type { Clip, MediaAsset } from '../state/models.ts';
import type { DepthRun } from './depth.ts';
import { createDepthPreview, depthAtSource, depthState, ensureDepthRun, rememberDepth, watchDepthClips } from './depthPreview.ts';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms)), tick = () => sleep(5);
const until = async (done: () => boolean, ms = 1000) => { for (let i = 0; i < ms / 5 && !done(); i++) await tick(); assert.ok(done()); };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
/** Source frames 64..191 at 24 fps in two 64-frame segments, under its own key. */
const runOf = (letter: string, extra: Partial<DepthRun> = {}): DepthRun => ({ key: letter.repeat(64), status: 'ready', progress: 100, mediaId: 'm', first: 64, frames: 128, times: Array.from({ length: 128 }, (_, i) => (64 + i) / 24), width: 4, height: 2, lo: 0, hi: 1, near: .9, far: .1, segments: [{ n: 0, first: 64, count: 64 }, { n: 1, first: 128, count: 64 }], next: 2, ...extra });
const at = (frame: number) => frame / 24;
const videoAsset = { id: 'm', kind: 'video', fps: 24, duration: 10, status: 'ready', resolution: '64 × 36' } as MediaAsset;
const clipOf = (id: string, extra: Partial<Clip> = {}) => ({ id, projectId: 'p', mediaId: 'm', start: 0, duration: 2, sourceIn: 3, properties: {}, effects: [{ id: `e-${id}`, name: 'Depth', enabled: true, amount: 100 }], ...extra }) as unknown as Clip;
/** A decoder like the real one: 30 ms to start, 5 ms a frame, and a newer request stops the older one at its next frame. */
class SlowWorker {
  static decodes: { segment: string; from: number; count: number }[] = [];
  onmessage?: (event: { data: unknown }) => void; generation = 0;
  postMessage(message: { id: number; segment: string; from: number; count: number }) {
    const epoch = ++this.generation; SlowWorker.decodes.push({ segment: message.segment, from: message.from, count: message.count });
    void (async () => {
      await sleep(30);
      for (let i = message.from; i < message.from + message.count; i++) {
        await sleep(5);
        if (epoch !== this.generation) return;
        this.onmessage?.({ data: { type: 'frame', id: message.id, index: i, data: new Uint8Array(8).fill(i), width: 4, height: 2 } });
      }
      this.onmessage?.({ data: { type: 'done', id: message.id } });
    })();
  }
  terminate() { this.generation++; }
}

test('depth frames come from the decoded picture timestamp; a missing frame falls back one frame at most', async () => {
  // Source frames 64..191 at 24 fps, analysed as two 64-frame segments.
  const run: DepthRun = { key: 'a'.repeat(64), status: 'ready', progress: 100, mediaId: 'm', first: 64, frames: 128, times: Array.from({ length: 128 }, (_, i) => (64 + i) / 24), width: 4, height: 2, lo: 0, hi: 1, near: .9, far: .1, segments: [{ n: 0, first: 64, count: 64 }, { n: 1, first: 128, count: 64 }], next: 2 };
  const posts: string[] = [], downloads: string[] = [], decodes: { from: number; count: number }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/depth' && init?.method === 'POST') { posts.push(String(init.body)); return new Response(JSON.stringify(run), { headers: { 'Content-Type': 'application/json' } }); }
    if (url.includes('/preview/')) { downloads.push(url); return new Response(new Uint8Array([0, 0, 0, 1])); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  // The worker answers with a frame per requested offset whose bytes say which offset it was.
  globalThis.Worker = class { onmessage?: (event: { data: unknown }) => void; postMessage(message: { id: number; from: number; count: number }) { decodes.push({ from: message.from, count: message.count }); queueMicrotask(() => { for (let i = message.from; i < message.from + message.count; i++) this.onmessage?.({ data: { type: 'frame', id: message.id, index: i, data: new Uint8Array(8).fill(i), width: 4, height: 2 } }); this.onmessage?.({ data: { type: 'done', id: message.id } }); }); } terminate() {} } as unknown as typeof Worker;
  const asset = { id: 'm', kind: 'video', fps: 24, duration: 10, status: 'ready', resolution: '64 × 36' } as MediaAsset;
  const clip = { id: 'c', projectId: 'p', mediaId: 'm', start: 0, duration: 2, sourceIn: 3, properties: {}, effects: [{ id: 'e', name: 'Depth', enabled: true, amount: 100 }] } as unknown as Clip;
  ensureDepthRun(clip, asset);
  await until(() => depthState('c')?.status === 'ready');
  let ready = 0;
  const preview = createDepthPreview(() => { ready++; });
  const at = (frame: number) => run.times[frame - 64];

  assert.deepEqual(preview.frame('c', at(74)), { state: 'loading' }, 'nothing decoded yet');
  await until(() => ready > 0);
  const exact = preview.frame('c', at(74) + .4 / 24);
  assert.equal(exact.state, 'ready');
  assert.equal(exact.state === 'ready' && exact.pixels.key, `${run.key}:74`, 'a timestamp inside the frame picks that frame');
  assert.equal(exact.state === 'ready' && exact.pixels.data[0], 10, 'offset 10 of segment 0');
  assert.deepEqual(decodes[0], { from: 10, count: 16 }, 'decodes a window forward from the frame');

  // Offsets 10..25 are decoded: offset 26 is not, so its frame shows offset 25's depth, never older.
  const stale = preview.frame('c', at(90));
  assert.equal(stale.state === 'ready' && stale.pixels.key, `${run.key}:89`);
  assert.deepEqual(preview.frame('c', at(160)), { state: 'loading' }, 'two frames old is no depth at all');
  assert.deepEqual(preview.frame('c', at(64) - .5), { state: 'analyzing' }, 'before the run: not covered');
  assert.deepEqual(preview.frame('nobody', 0), { state: 'none' });

  // Past three quarters of segment 0 the next segment downloads.
  preview.frame('c', at(64 + 50));
  await until(() => downloads.some(url => url.includes('/preview/1.mp4')));

  // Every trim asks the server, which alone picks the clip's run (the one its exports read); the run shown keeps playing
  // while it is asked, and stays when the server keeps it.
  ensureDepthRun({ ...clip, sourceIn: 4 }, asset);
  assert.equal(depthState('c')?.status, 'ready'); assert.equal(depthState('c')?.run?.key, run.key);
  assert.equal(preview.frame('c', at(74)).state, 'ready', 'no gap in the picture while the server is asked');
  await until(() => posts.length === 2 && !depthState('c')!.asking);
  assert.equal(depthState('c')?.run?.key, run.key);

  // The focus picker reads the frame drawn last.
  rememberDepth('c', { pixels: { data: new Uint8Array([230, 230, 25, 25, 230, 230, 25, 25]), width: 4, height: 2, key: 'x' }, near: .9, far: .1 });
  assert.ok(depthAtSource('c', .1, .5)! < 5 && depthAtSource('c', .9, .5)! > 95);
  assert.equal(depthAtSource('c', 1.2, .5), undefined);
  preview.dispose();
});

test('two Depth clips on screen both get depth, and a reversed clip decodes backward', async () => {
  const runs: Record<string, DepthRun> = { ca: runOf('b'), cb: runOf('c') };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/depth' && init?.method === 'POST') return json(runs[JSON.parse(String(init.body)).clipId]);
    if (url.includes('/preview/')) return new Response(new Uint8Array(4));
    return json({ error: 'Depth analysis not found.' }, 404);
  }) as typeof fetch;
  globalThis.Worker = SlowWorker as unknown as typeof Worker;
  ensureDepthRun(clipOf('ca'), videoAsset); ensureDepthRun(clipOf('cb'), videoAsset);
  await until(() => depthState('ca')?.status === 'ready' && depthState('cb')?.status === 'ready');
  // A dissolve: both clips play, a frame each per tick. Each used to stop the other's decode, leaving both bare.
  let preview = createDepthPreview(() => {}), a = 0, b = 0;
  for (let i = 0; i < 60; i++) {
    if (preview.frame('ca', at(64 + i)).state === 'ready') a++;
    if (preview.frame('cb', at(100 + i)).state === 'ready') b++;
    await sleep(25);
  }
  assert.ok(a >= 30 && b >= 30, `both clips have depth: ${a} and ${b} of 60 ticks`);
  preview.dispose();

  // Reversed: a window ending at the frame is decoded, and the fallback is the frame shown before (one later).
  preview = createDepthPreview(() => {}); SlowWorker.decodes = [];
  let ready = 0;
  for (let i = 0; i < 48; i++) { if (preview.frame('ca', at(180 - i)).state === 'ready') ready++; await sleep(25); }
  assert.ok(SlowWorker.decodes.length <= 8, `a decode per window, not per frame: ${SlowWorker.decodes.length}`);
  assert.ok(ready >= 30, `reversed play has depth: ${ready} of 48`);
  await until(() => { const shown = preview.frame('ca', at(112)); return shown.state === 'ready' && shown.pixels.key === `${runs.ca.key}:112`; });
  const fallback = preview.frame('ca', at(111));
  assert.equal(fallback.state === 'ready' && fallback.pixels.key, `${runs.ca.key}:112`, 'reversed, the frame shown before is the later one');
  preview.dispose();
});

test('a failed segment download is retried by itself, and a ready run the server lost is analysed again', async () => {
  const run = runOf('d');
  let posts = 0, failures = 1, missing = false, downloads = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/depth' && init?.method === 'POST') return json(++posts === 1 ? run : { ...run, status: 'queued', progress: 0, segments: [], next: 0 });
    if (url.startsWith(`/api/depth/${run.key}?`)) return json({ ...run, status: 'queued', progress: 0, segments: [], next: 0, times: [] });
    if (url.includes('/preview/')) { downloads++; return missing ? json({ error: 'Depth segment not found.' }, 404) : failures-- > 0 ? new Response('<html>Bad gateway</html>', { status: 502 }) : new Response(new Uint8Array(4)); }
    return json({ error: 'Depth analysis not found.' }, 404);
  }) as typeof fetch;
  globalThis.Worker = SlowWorker as unknown as typeof Worker;
  ensureDepthRun(clipOf('cd'), videoAsset);
  await until(() => depthState('cd')?.status === 'ready');
  let repaints = 0;
  const preview = createDepthPreview(() => { repaints++; });
  assert.equal(preview.frame('cd', at(70)).state, 'loading');
  await until(() => downloads === 1);
  await tick();
  // Asking again within two seconds neither downloads again nor locks the frames up.
  assert.equal(preview.frame('cd', at(70)).state, 'loading'); assert.equal(downloads, 1);
  // Paused, nothing else would draw the frame again: the retry repaints by itself.
  await until(() => repaints > 0, 3000);
  preview.frame('cd', at(70));
  await until(() => preview.frame('cd', at(70)).state === 'ready');

  // The server's cache evicted the run: a segment 404 asks for the analysis again rather than playing bare forever.
  missing = true;
  preview.frame('cd', at(64 + 64 + 3));
  await until(() => posts === 2);
  await until(() => depthState('cd')?.status === 'queued');
  preview.dispose();
});

test('a dropped request is retried, a trim made while starting is checked, and a replaced run is cancelled', async () => {
  const first = runOf('e', { status: 'queued', progress: 0, segments: [], next: 0 }), second = runOf('f');
  let posts = 0, release = () => {};
  const deletes: string[] = [], polls: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/depth' && init?.method === 'POST') {
      posts++;
      if (posts === 1) return new Response('<html>Bad gateway</html>', { status: 502 });
      if (posts === 2) { await new Promise<void>(resolve => { release = resolve; }); return json(first); }
      return json(second);
    }
    if (init?.method === 'DELETE') { deletes.push(url); return json({ ok: true }); }
    if (url.startsWith(`/api/depth/${first.key}?`)) { polls.push(url); return json({ ...first, times: [] }); }
    return json({ error: 'Depth analysis not found.' }, 404);
  }) as typeof fetch;
  const clip = clipOf('ce');
  ensureDepthRun(clip, videoAsset);
  await until(() => posts === 1 && !!depthState('ce')?.error);
  assert.equal(depthState('ce')!.status, 'starting', 'a tunnel 502 does not fail the run');
  assert.match(depthState('ce')!.error!, /^Server request failed \(502\) · retrying$/, 'the HTML page reads as a plain message');
  await until(() => posts === 2, 3000);
  // The clip is slipped far past the handles while the request is out; the run that comes back covers the old range.
  ensureDepthRun({ ...clip, sourceIn: 7 }, videoAsset);
  release();
  await until(() => posts === 3);
  await until(() => depthState('ce')?.status === 'ready');
  assert.equal(depthState('ce')!.run!.key, second.key);
  assert.deepEqual(deletes, [`/api/depth/${first.key}?projectId=p`], 'the replaced queued run gives the GPU queue up');
  assert.ok(polls.every(url => url.includes('&times=0')), 'polls never download the times again');
});

test('a Depth clip keeps its run while the effect is off or another project is open; removing Depth cancels it', async () => {
  const run = runOf('g', { status: 'queued', progress: 0, segments: [], next: 0 });
  let posts = 0;
  const deletes: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/depth' && init?.method === 'POST') { posts++; return json(run); }
    if (init?.method === 'DELETE') { deletes.push(url); return json({ ok: true }); }
    if (url.startsWith(`/api/depth/${run.key}?`)) return json({ ...run, times: [] });
    return json({ error: 'Depth analysis not found.' }, 404);
  }) as typeof fetch;
  const listeners: ((state: { projectId: string; clips: Clip[]; media: MediaAsset[] }) => void)[] = [];
  let state = { projectId: 'p', clips: [clipOf('cw')], media: [videoAsset] };
  const set = (next: Partial<typeof state>) => { state = { ...state, ...next }; for (const listener of listeners) listener(state); };
  (globalThis as { window?: unknown }).window = globalThis;
  try { watchDepthClips({ getState: () => state, subscribe: listener => listeners.push(listener) }); } finally { delete (globalThis as { window?: unknown }).window; }
  await until(() => depthState('cw')?.status === 'queued');
  set({ clips: [clipOf('cw', { effects: [{ id: 'e-cw', name: 'Depth', enabled: false, amount: 100 }] })] });
  assert.equal(depthState('cw')?.status, 'queued', 'turning Depth off for a before/after look keeps the analysis');
  set({ projectId: 'other' });
  assert.equal(depthState('cw'), undefined); assert.deepEqual(deletes, [], 'opening another project stops watching, nothing more');
  set({ projectId: 'p' });
  await until(() => posts === 2 && depthState('cw')?.status === 'queued');
  // A transition widens the run by its handles (depthSpan), so the server is asked again.
  set({ clips: [clipOf('cw', { transition: 'Cross dissolve' })] });
  await until(() => posts === 3);
  set({ clips: [clipOf('cw', { effects: [] })] });
  assert.equal(depthState('cw'), undefined);
  assert.deepEqual(deletes, [`/api/depth/${run.key}?projectId=p`], 'removing Depth frees the GPU');
});

test('the server picks the run: a trim keeps or replaces it as told, and a run someone else cancelled is asked for again', async () => {
  const queued = (letter: string) => runOf(letter, { status: 'queued', progress: 0, segments: [], next: 0 });
  const first = queued('h'), ready = runOf('j'), other = queued('k');
  let answer: DepthRun = first, posts = 0, cancelled = false;
  const deletes: string[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/depth' && init?.method === 'POST') { posts++; return json(answer); }
    if (init?.method === 'DELETE') { deletes.push(url); return json({ ok: true }); }
    if (url.startsWith(`/api/depth/${first.key}?`)) return json({ ...first, times: [], ...cancelled ? { status: 'cancelled', error: 'Cancelled.' } : {} });
    if (url.startsWith(`/api/depth/${other.key}?`)) return json({ ...other, times: [] });
    return json({ error: 'Depth analysis not found.' }, 404);
  }) as typeof fetch;
  const clip = clipOf('cq');
  ensureDepthRun(clip, videoAsset);
  await until(() => depthState('cq')?.status === 'queued');
  // The server keeps the queued run for the trimmed clip: nothing is cancelled and it never shows as starting.
  ensureDepthRun({ ...clip, sourceIn: 4 }, videoAsset);
  assert.equal(depthState('cq')?.status, 'queued');
  await until(() => posts === 2 && !depthState('cq')!.asking);
  assert.equal(depthState('cq')?.run?.key, first.key); assert.deepEqual(deletes, []);
  // Another editor's trim cancels it: this clip still needs a run, so it asks and gets the one the server picks now.
  answer = ready; cancelled = true;
  await until(() => posts === 3 && depthState('cq')?.status === 'ready', 3000);
  assert.equal(depthState('cq')?.run?.key, ready.key); assert.deepEqual(deletes, [], 'a run someone else cancelled is not cancelled again');
  // Replaced by a run still queued, then back: the queued one nothing reads any more gives the GPU up.
  answer = other; ensureDepthRun({ ...clip, sourceIn: 5 }, videoAsset);
  await until(() => posts === 4 && depthState('cq')?.run?.key === other.key);
  assert.deepEqual(deletes, [], 'a ready run it leaves costs nothing');
  answer = ready; ensureDepthRun({ ...clip, sourceIn: 4 }, videoAsset);
  await until(() => posts === 5 && depthState('cq')?.run?.key === ready.key);
  assert.deepEqual(deletes, [`/api/depth/${other.key}?projectId=p`]);
});
