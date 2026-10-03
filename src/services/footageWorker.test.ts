import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/** Runs public/footage-worker.js against a fake Cache Storage and a fake range-serving origin. */
function worker(file: Buffer, truncated = false) {
  const listeners: Record<string, (event: any) => void> = {};
  // Chrome's Cache Storage ignores the fragment of a key, so the fake normalises the same way.
  const store = new Map<string, Response>();
  const normal = (key: string) => { const url = new URL(key, 'https://sharedcut.test'); url.hash = ''; return url.href; };
  const cache = {
    match: async (key: string) => store.get(normal(key))?.clone(),
    put: async (key: string, response: Response) => { const bytes = await response.arrayBuffer(); store.set(normal(key), new Response(bytes, { headers: response.headers })); },
    keys: async () => [...store.keys()].map(key => new Request(key)),
    delete: async (key: string) => store.delete(normal(key)),
  };
  let network = 0;
  const origin = async (request: Request) => {
    network++;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') || '');
    if (!range) return new Response(new Uint8Array(file), { status: 200 });
    const start = Number(range[1]), end = Math.min(file.length - 1, range[2] ? Number(range[2]) : file.length - 1);
    if (start >= file.length) return new Response(null, { status: 416 });
    return new Response(new Uint8Array(file.subarray(start, truncated ? end : end + 1)), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Accept-Ranges': 'bytes' } });
  };
  const sandbox: Record<string, unknown> = {
    self: { addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {}, matchAll: async () => [] }, location: { origin: 'https://sharedcut.test' } },
    caches: { open: async () => cache, delete: async () => { store.clear(); return true; } },
    fetch: origin, Request, Response, Headers, URL, ReadableStream, TransformStream, Uint8Array, Date, Math, Number, JSON, Promise, console, Error, RegExp, performance,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../../public/footage-worker.js', import.meta.url), 'utf8'), sandbox);
  const request = async (path: string, range?: string, cacheOff = false) => {
    const event = { request: new Request(`https://sharedcut.test${path}`, { headers: { ...(range ? { Range: range } : {}), ...(cacheOff ? {'X-Footage-Cache':'off'} : {}) } }), response: undefined as Promise<Response> | undefined, respondWith(value: Promise<Response>) { this.response = value; } };
    listeners.fetch(event);
    return event.response ? await event.response : null;
  };
  return { request, network: () => network, store };
}

test('ranges are assembled from 1 MiB chunks, cached, and replayed without the network', async () => {
  const file = randomBytes(3.5 * 1024 * 1024);
  const sw = worker(file);
  const path = '/api/media/media-1/files/stream-v2.mp4';

  const first = await sw.request(path, 'bytes=100-2500000');
  assert.equal(first!.status, 206);
  assert.equal(first!.headers.get('Content-Range'), `bytes 100-2500000/${file.length}`);
  assert.ok(Buffer.from(await first!.arrayBuffer()).equals(file.subarray(100, 2500001)), 'bytes match the origin');
  assert.equal(sw.network(), 3, 'three aligned chunks fetched once');

  const again = await sw.request(path, 'bytes=100-2500000');
  assert.ok(Buffer.from(await again!.arrayBuffer()).equals(file.subarray(100, 2500001)));
  assert.equal(sw.network(), 3, 'served entirely from the cache');

  const tail = await sw.request(path, 'bytes=3000000-');
  assert.equal(tail!.headers.get('Content-Range'), `bytes 3000000-${file.length - 1}/${file.length}`);
  assert.ok(Buffer.from(await tail!.arrayBuffer()).equals(file.subarray(3000000)), 'open-ended range reaches the end of the file');
  assert.equal(sw.network(), 4, 'only the one remaining chunk was fetched');
  assert.equal(await sw.request(path, 'bytes=999999999-').then(r => r!.status), 416);

  assert.equal(await sw.request(path), null, 'a request without Range is left to the browser');
  assert.equal(await sw.request('/api/media/media-1/original', 'bytes=0-10'), null, 'originals are never cached');
  assert.equal(await sw.request('/api/state', 'bytes=0-10'), null, 'non-media is untouched');
  assert.equal(await sw.request(path, 'bytes=0-10', true), null, 'Cache Off also bypasses interception for decoder workers.');
  for (let i = 0; i < 50 && !sw.store.has(`https://sharedcut.test${path}?fc=meta`); i++) await new Promise(r => setTimeout(r, 1));
  const meta = await sw.store.get(`https://sharedcut.test${path}?fc=meta`)!.json();
  assert.equal(meta.size, file.length);
});

test('a short range on a miss streams the bytes while the whole chunk still lands in the cache', async () => {
  const file = randomBytes(1.5 * 1024 * 1024);
  const sw = worker(file);
  const path = '/api/media/media-2/files/stream-v2.mp4';
  const short = await sw.request(path, 'bytes=100-200');
  assert.ok(Buffer.from(await short!.arrayBuffer()).equals(file.subarray(100, 201)));
  assert.equal(sw.network(), 1);
  // The cache branch of the tee keeps draining after the client stopped reading.
  for (let i = 0; i < 50 && !(sw.store.get(`https://sharedcut.test${path}?fc=0`)); i++) await new Promise(r => setTimeout(r, 10));
  const stored = await sw.store.get(`https://sharedcut.test${path}?fc=0`)!.clone().arrayBuffer();
  assert.equal(stored.byteLength, 1024 * 1024, 'the full aligned chunk was cached');
  const whole = await sw.request(path, 'bytes=0-1048575');
  assert.ok(Buffer.from(await whole!.arrayBuffer()).equals(file.subarray(0, 1024 * 1024)));
  assert.equal(sw.network(), 1, 'served from the cache');
});


test('simultaneous decoder and prefetch requests share the same network chunks', async () => {
  const file = randomBytes(2 * 1024 * 1024), sw = worker(file);
  const responses = await Promise.all(Array.from({length: 4}, () => sw.request('/api/media/shared/files/stream.mp4', 'bytes=0-1048575')));
  for (const response of responses) assert.deepEqual(Buffer.from(await response!.arrayBuffer()), file.subarray(0, 1048576));
  assert.equal(sw.network(), 1);
});


test('truncated network bodies cannot become cached chunks', async () => {
  const sw = worker(randomBytes(1024 * 1024), true);
  const response = await sw.request('/api/media/broken/files/stream.mp4', 'bytes=0-1048575');
  await assert.rejects(() => response!.arrayBuffer(), /Incomplete/);
  assert.equal(sw.store.size, 0);
});
