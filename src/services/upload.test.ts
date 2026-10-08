import assert from 'node:assert/strict';
import test from 'node:test';
import { findUnfinishedUpload, uploadSource } from './upload.ts';
import type { MediaAsset } from '../state/models.ts';

test('reselecting an interrupted file resumes its verified offset and reports progress', async t => {
  const file = new File(['abcdefghij'], 'clip.bin', { lastModified: 123 });
  const assets = [
    { id: 'ready', name: file.name, status: 'ready' },
    { id: 'different', name: file.name, status: 'uploading' },
    { id: 'interrupted', name: file.name, status: 'uploading' },
  ] as MediaAsset[];
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push(`${init.method ?? 'GET'} ${url}`);
    if (url.includes('/different/')) return Response.json({ offset: 0, complete: false, metadata: { fingerprint: 'clip.bin:10:999' } });
    if (init.method === 'PUT') {
      assert.equal((init.headers as Record<string, string>)['Upload-Offset'], '4');
      assert.equal(new TextDecoder().decode(init.body as ArrayBuffer), 'efghij');
      return Response.json({ offset: 10, complete: true });
    }
    return Response.json({ offset: 4, complete: false, metadata: { fingerprint: 'clip.bin:10:123' } });
  });
  const id = await findUnfinishedUpload(file, assets);
  assert.equal(id, 'interrupted');
  const progress: number[] = [];
  let resumedBytes = 0;
  await uploadSource(id!, file, value => progress.push(value), undefined, detail => { resumedBytes = detail.resumedBytes ?? 0; });
  assert.equal(resumedBytes, 4, 'speed and transferred bytes must exclude previously uploaded data');
  assert.deepEqual(progress, [40, 100]);
  assert.equal(requests.some(request => request.includes('/ready/')), false);
  assert.equal(await findUnfinishedUpload(new File(['x'], 'other.bin'), assets), undefined);
});

test('a timed-out chunk retries using a fresh bounded request', async t => {
  let puts = 0;
  const signals = new Set<AbortSignal>();
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(signals.has(init.signal), false);
    signals.add(init.signal);
    if (init.method === 'PUT' && ++puts === 1) throw new DOMException('Transfer timed out', 'TimeoutError');
    return Response.json({ offset: init.method === 'PUT' ? 3 : 0, complete: init.method === 'PUT' });
  });
  const progress: number[] = [];
  await uploadSource('source', new File(['abc'], 'clip.bin'), value => progress.push(value));
  assert.equal(puts, 2);
  assert.deepEqual(progress, [0, 100]);
});

test('the queue shows all files, bounds concurrency, pauses a stalled file, and resumes without duplicates', async t => {
  const { enqueueUploads, pauseUpload, resumeUpload, resetUploads, uploadQueue } = await import('./upload.ts');
  const { connection } = await import('./api.ts');
  resetUploads();
  t.mock.method(connection, 'flush', async () => {});
  t.mock.method(connection, 'refresh', async () => {});
  const names = new Map<string, string>();
  let blocked = true, active = 0, maxActive = 0, created = 0;
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!condition()) { assert.ok(Date.now() < deadline, 'queue failed to advance'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith('/api/media?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      names.set(params.get('id')!, params.get('name')!); created++;
      return Response.json({});
    }
    const id = url.split('/')[3];
    if (init.method === 'PUT') {
      active++; maxActive = Math.max(active, maxActive);
      try {
        if (names.get(id) === 'one.bin' && blocked) await new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
        return Response.json({ offset: 3, complete: true });
      } finally { active--; }
    }
    return Response.json({ offset: 0, complete: false });
  });
  try {
    const files = ['one.bin','two.bin','three.bin'].map(name => new File(['abc'], name));
    enqueueUploads('project', files, []);
    enqueueUploads('project', files, []);
    assert.equal(uploadQueue.getState().jobs.length, 3);
    await waitFor(() => uploadQueue.getState().jobs.filter(job => job.status === 'uploaded').length === 2);
    const first = uploadQueue.getState().jobs[0];
    pauseUpload(first.key);
    await waitFor(() => active === 0);
    assert.equal(uploadQueue.getState().jobs[0].status, 'paused');
    blocked = false;
    resumeUpload(first.key);
    await waitFor(() => uploadQueue.getState().jobs.every(job => job.status === 'uploaded'));
    assert.equal(created, 3);
    assert.ok(maxActive <= 2);
    assert.ok(uploadQueue.getState().jobs.every(job => !job.file), 'completed jobs release file handles');
  } finally { resetUploads(); }
});

// uploadImport against a fake server: `script` may answer a request itself (a status, a thrown error, a delay) before
// the fake's own resumable-upload rules do.
type Hook = (method: string, id: string, init: RequestInit) => Promise<Response | void> | Response | void;
function fakeImport(t: import('node:test').TestContext, sizes: Record<string, number>, { complete = [] as string[], offsets = {} as Record<string, number>, script = (() => {}) as Hook, health = () => Response.json({}) } = {}) {
  const log: string[] = [], offset = new Map(Object.entries(sizes).map(([id, size]) => [id, complete.includes(id) ? size : offsets[id] ?? 0]));
  let inFlight = 0, most = 0, plan: any;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET', id = url.split('/')[3];
    log.push(`${method} ${url.replace('/api', '')}`);
    if (url === '/api/health') return health();
    if (url.startsWith('/api/fcp/import/')) { plan = JSON.parse(String(init.body)); return Response.json({ files: plan.files.map((f: any) => ({ id: f.id, received: offset.get(f.id), complete: offset.get(f.id) === sizes[f.id] })) }); }
    if (method === 'PUT') { most = Math.max(most, ++inFlight); }
    try {
      const scripted = await script(method, id, init);
      if (scripted) return scripted;
      if (method === 'PUT') {
        assert.equal(Number((init.headers as Record<string, string>)['Upload-Offset']), offset.get(id));
        offset.set(id, offset.get(id)! + (init.body as ArrayBuffer).byteLength);
      }
      return Response.json({ offset: offset.get(id), complete: offset.get(id) === sizes[id] });
    } finally { if (method === 'PUT') inFlight--; }
  });
  return { log, offset, plan: () => plan, most: () => most };
}
const blob = (name: string, size: number) => new File([new Uint8Array(size)], name, { lastModified: 7 });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
/** Runs `work` on mocked timers, moving the clock a second at a time whenever nothing else is left to do. */
async function onClock<T>(t: import('node:test').TestContext, work: () => Promise<T>) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  let finished = false;
  const running = work().finally(() => { finished = true; });
  running.catch(() => {});
  for (let i = 0; !finished && i < 5000; i++) { await settle(); if (!finished) t.mock.timers.tick(1000); }
  return running;
}

test('uploadImport plans first, sends the largest files first, never more than `lanes` at once, and skips what arrived', async t => {
  const { uploadImport } = await import('./upload.ts');
  const sizes = { a: 10, b: 60, c: 30, d: 50, e: 20 };
  const server = fakeImport(t, sizes, { complete: ['d'], offsets: { a: 4 }, script: async method => { if (method === 'PUT') await new Promise(resolve => setTimeout(resolve, 5)); } });
  const items = Object.entries(sizes).map(([id, size]) => ({ assetId: id, file: blob(`${id}.bin`, size) })), seen: number[] = [];
  const done = await uploadImport('fcp-1', [...items, { assetId: 'empty', file: blob('empty.bin', 0) }], { lanes: 2, onProgress: p => seen.push(p.bytes) });
  assert.equal(server.log[0], 'PUT /fcp/import/fcp-1');
  assert.deepEqual(server.plan().files, items.map(i => ({ id: i.assetId, size: i.file.size, fingerprint: `${i.assetId}.bin:${i.file.size}:7` })), 'the empty file is left out of the plan');
  assert.deepEqual(server.log.filter(l => l.startsWith('POST')).map(l => l.split('/')[2]), ['b', 'c', 'e', 'a'], 'largest first; the finished file is not sent');
  assert.ok(server.most() <= 2, `${server.most()} PUTs at once`);
  assert.deepEqual({ ...done, rate: 0, eta: undefined }, { bytes: 170, total: 170, rate: 0, eta: undefined, files: 5, sent: 5, lanes: 2, waiting: undefined, failed: [{ id: 'empty', reason: 'The file is empty.' }], sending: [undefined, undefined], received: { a: 10, b: 60, c: 30, d: 50, e: 20 } });
  assert.equal(seen[0], 54, 'progress starts from what the server already has');
});

test('uploadImport retries a dropped connection and a moved offset, and leaves out only the file the server refuses', async t => {
  const { uploadImport } = await import('./upload.ts');
  let posts = 0, puts = 0;
  const server = fakeImport(t, { a: 30, b: 20, c: 10 }, { script: (method, id) => {
    if (id === 'a' && method === 'POST' && ++posts === 1) throw new TypeError('Failed to fetch');
    // The chunk landed but its answer was lost: the next PUT is refused and the server's offset moves on.
    if (id === 'b' && method === 'PUT' && ++puts === 1) { server.offset.set('b', 20); return Response.json({ error: 'Upload offset changed. Resume from the server offset.' }, { status: 409 }); }
    if (id === 'c' && method === 'POST') return Response.json({ error: 'Files must be smaller than 10 GB.' }, { status: 413 });
  } });
  const done = await onClock(t, () => uploadImport('fcp-1', [['a', 30], ['b', 20], ['c', 10]].map(([id, size]) => ({ assetId: id as string, file: blob(`${id}.bin`, size as number) }))));
  assert.deepEqual([done.sent, done.failed], [2, [{ id: 'c', reason: 'Files must be smaller than 10 GB.' }]]);
  assert.ok(server.log.includes('GET /health'), 'it waited for the server before trying again');
  assert.equal(server.log.filter(l => l === 'PUT /media/b/upload').length, 1, 'the moved offset finished b without sending it again');
});

test('uploadImport holds every lane while the server is out of room, and stops everything when signed out', async t => {
  const { uploadImport } = await import('./upload.ts');
  let full = true;
  const server = fakeImport(t, { a: 10, b: 10 }, { script: method => { if (full && method === 'POST') return Response.json({ error: 'The server is almost out of disk space.' }, { status: 507 }); } });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const progress: string[] = [];
  const running = uploadImport('fcp-1', [{ assetId: 'a', file: blob('a.bin', 10) }, { assetId: 'b', file: blob('b.bin', 10) }], { onProgress: p => progress.push(p.waiting ?? '') });
  const posts = () => server.log.filter(l => l.startsWith('POST')).length;
  await settle();
  assert.equal(posts(), 2);
  t.mock.timers.tick(59_000); await settle();
  assert.equal(posts(), 2, 'nobody asks again within the minute');
  t.mock.timers.tick(1000); await settle();
  assert.equal(posts(), 3, 'one lane asks for everyone');
  assert.ok(progress.includes('full'));
  full = false;
  t.mock.timers.tick(60_000); await settle();
  const done = await running;
  assert.deepEqual([done.sent, done.failed], [2, []]);
  t.mock.timers.reset();

  const held: AbortSignal[] = [];
  const signedOut = fakeImport(t, { a: 10, b: 10 }, { script: (method, id, init) => {
    if (method !== 'PUT') return;
    if (id === 'a') return Response.json({ error: 'Sign in' }, { status: 401 });
    held.push(init.signal!);
    return new Promise((_, reject) => { init.signal!.addEventListener('abort', () => reject(init.signal!.reason)); if (init.signal!.aborted) reject(init.signal!.reason); });
  } });
  await assert.rejects(uploadImport('fcp-1', [{ assetId: 'a', file: blob('a.bin', 10) }, { assetId: 'b', file: blob('b.bin', 10) }]), { status: 401 });
  assert.equal(held.length, 1); assert.equal(held[0].aborted, true, 'the other lane stopped too');
  assert.equal(signedOut.log.filter(l => l === 'PUT /media/a/upload').length, 1);
});

test('uploadImport counts a resumed offset in its bytes but never in its rate', async t => {
  const { uploadImport } = await import('./upload.ts');
  const size = 4e9, resumed = size - 16;
  // A 4 GB file whose first 4 GB already arrived: only its last 16 bytes travel, over two seconds.
  const big = { name: 'big.bin', size, lastModified: 7, type: '', slice: (from: number, to: number) => new Blob([new Uint8Array(Math.min(to, size) - from)]) } as unknown as File;
  fakeImport(t, { big: size }, { offsets: { big: resumed }, script: async method => { if (method === 'PUT') await new Promise(resolve => setTimeout(resolve, 2000)); } });
  const rates: number[] = [];
  const done = await onClock(t, () => uploadImport('fcp-1', [{ assetId: 'big', file: big }], { onProgress: p => rates.push(p.rate) }));
  assert.deepEqual([done.bytes, done.total, done.sent], [size, size, 1]);
  assert.ok(rates.every(rate => rate <= 16), `rates ${rates}`);
  assert.ok(rates.at(-1)! > 0);
});

test('uploadImport on a link that carries one chunk a minute: timeouts drop lanes, the extra lanes hand their files back, every file lands', async t => {
  const { uploadImport } = await import('./upload.ts');
  // Under ~140 KB/s a lane's 8 MiB chunk cannot land inside its 60 s: two chunks on the line at once both run out of time.
  const going = new Set<{ overlapped: boolean }>(); let timeouts = 0;
  fakeImport(t, { a: 100, b: 100, c: 100, d: 100 }, { script: async method => {
    if (method !== 'PUT') return;
    const me = { overlapped: going.size > 0 }; for (const other of going) other.overlapped = true; going.add(me);
    await new Promise(resolve => setTimeout(resolve, 60_000)); going.delete(me);
    if (me.overlapped) { timeouts++; throw new DOMException('The operation timed out.', 'TimeoutError'); }
  } });
  const widths: number[] = [];
  const done = await onClock(t, () => uploadImport('fcp-1', ['a', 'b', 'c', 'd'].map(id => ({ assetId: id, file: blob(`${id}.bin`, 100) })), { lanes: 4, onProgress: p => widths.push(p.lanes) }));
  assert.deepEqual([done.sent, done.failed], [4, []]);
  assert.ok(timeouts > 0, 'the four lanes ran out of time together'); assert.equal(widths.at(-1), 1);
});

test('uploadImport: a file the server still calls busy past 20 s reads as SharedCut not answering', async t => {
  const { uploadImport } = await import('./upload.ts');
  let since: number | undefined;
  // The server is still reading a request the Wi-Fi dropped: for 40 s every POST for the file hears "busy".
  fakeImport(t, { a: 10 }, { script: method => { if (method === 'POST' && Date.now() - (since ??= Date.now()) < 40_000) return Response.json({ error: 'Upload is busy.' }, { status: 409 }); } });
  const waiting: (string | undefined)[] = [];
  const done = await onClock(t, () => uploadImport('fcp-1', [{ assetId: 'a', file: blob('a.bin', 10) }], { onProgress: p => waiting.push(p.waiting) }));
  assert.equal(done.sent, 1);
  assert.equal(waiting.slice(0, 15).filter(Boolean).length, 0, 'not at once');
  assert.ok(waiting.includes('server'));
});

test("uploadImport: the tunnel's 502 page is not SharedCut answering; a file that failed leaves the plan so the card can finish", async t => {
  const { uploadImport } = await import('./upload.ts');
  const page = () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
  let checks = 0, puts = 0;
  const server = fakeImport(t, { a: 10, b: 10, c: 10 }, { health: () => ++checks <= 3 ? page() : Response.json({}), script: (method, id) => {
    if (id === 'a' && method === 'PUT' && ++puts === 1) return page();
    if (id === 'c' && method === 'POST') return Response.json({ error: 'Files must be smaller than 10 GB.' }, { status: 413 });
  } });
  const waiting: (string | undefined)[] = [];
  const done = await onClock(t, () => uploadImport('fcp-1', ['a', 'b', 'c'].map(id => ({ assetId: id, file: blob(`${id}.bin`, 10) })), { onProgress: p => waiting.push(p.waiting) }));
  assert.deepEqual([done.sent, done.failed.map(f => f.id)], [2, ['c']]);
  assert.equal(checks, 4, 'the gate waited through three 502 pages');
  assert.ok(waiting.includes('server'));
  assert.equal(server.log.filter(l => l === 'PUT /fcp/import/fcp-1').length, 2);
  assert.deepEqual(server.plan().files.map((f: { id: string }) => f.id), ['a', 'b'], 'planned again without the refused file');
});

test('uploadImport keeps the last rate while a slow lane is between acknowledgements', async t => {
  const { uploadImport } = await import('./upload.ts');
  // Three 8 MiB chunks, 30 s each: a 20 s window often holds none of them.
  const size = 2 * 8 * 1024 * 1024 + 1;
  fakeImport(t, { a: size }, { script: async method => { if (method === 'PUT') await new Promise(resolve => setTimeout(resolve, 30_000)); } });
  const seen: { bytes: number; rate: number; sending: boolean }[] = [];
  await onClock(t, () => uploadImport('fcp-1', [{ assetId: 'a', file: blob('a.bin', size) }], { onProgress: p => seen.push({ bytes: p.bytes, rate: p.rate, sending: p.sending.some(Boolean) }) }));
  const after = seen.filter(p => p.bytes > 0 && p.bytes < size && p.sending);
  assert.ok(after.length > 20); assert.ok(after.every(p => p.rate > 0), 'never 0.0 MB/s mid-upload');
});
