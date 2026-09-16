import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/** Runs public/footage-worker.js against a fake Cache Storage and a fake range-serving origin. */
function worker(file: Buffer) {
  const listeners: Record<string, (event: any) => void> = {};
  const store = new Map<string, Response>();
  const cache = {
    match: async (key: string) => store.get(key)?.clone(),
    put: async (key: string, response: Response) => { store.set(key, response); },
    keys: async () => [...store.keys()].map(key => new Request(`https://sharedcut.test${key}`)),
    delete: async (key: string) => store.delete(key),
  };
  let network = 0;
  const origin = async (request: Request) => {
    network++;
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') || '');
    if (!range) return new Response(file, { status: 200 });
    const start = Number(range[1]), end = Math.min(file.length - 1, range[2] ? Number(range[2]) : file.length - 1);
    if (start >= file.length) return new Response(null, { status: 416 });
    return new Response(file.subarray(start, end + 1), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Accept-Ranges': 'bytes' } });
  };
  const sandbox: Record<string, unknown> = {
    self: { addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {}, matchAll: async () => [] }, location: { origin: 'https://sharedcut.test' } },
    caches: { open: async () => cache, delete: async () => { store.clear(); return true; } },
    fetch: origin, Request, Response, Headers, URL, ReadableStream, Uint8Array, Date, Math, Number, JSON, Promise, console, Error, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(new URL('../../public/footage-worker.js', import.meta.url), 'utf8'), sandbox);
  const request = async (path: string, range?: string) => {
    const event = { request: new Request(`https://sharedcut.test${path}`, { headers: range ? { Range: range } : {} }), response: undefined as Promise<Response> | undefined, respondWith(value: Promise<Response>) { this.response = value; } };
    listeners.fetch(event);
    return event.response ? await event.response : null;
  };
  return { request, network: () => network, store };
}

test('ranges are assembled from 1 MiB chunks, cached, and replayed without the network', async () => {
  const file = randomBytes(3.5 * 1024 * 1024);
  const sw = worker(file);
  const path = '/api/media/media-1/files/stream-v1.mp4';

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
  const meta = await sw.store.get(`${path}#meta`)!.json();
  assert.equal(meta.size, file.length);
});
