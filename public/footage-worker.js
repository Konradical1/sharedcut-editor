/* SharedCut footage cache.
 *
 * Every byte of proxy footage otherwise travels browser → Cloudflare → tunnel → server, and a
 * <video> element asks for it as a long series of small byte ranges. This worker answers those
 * ranges out of Cache Storage, one aligned 1 MiB chunk at a time, and fills gaps from the network so
 * anything that has played once never crosses the tunnel again. The page (footageCache.ts) decides
 * what to pull ahead; it fetches ordinary ranges through here, which is what fills the cache.
 *
 * Cache entries: `<url>?fc=<index>` holds chunk bytes, `<url>?fc=meta` holds {size, type, used}.
 * The marker is a query parameter because Cache Storage ignores URL fragments when matching.
 */
const CACHE = 'footage-v2';
const CHUNK = 1 << 20;
const MEDIA = /^\/api\/.+\.(mp4|m4a|mov|webm)$/i;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(Promise.all([self.clients.claim(), caches.delete('footage-v1')])));

const keyFor = (url, marker) => `${url}${url.includes('?') ? '&' : '?'}fc=${marker}`;
const chunkKey = (url, index) => keyFor(url, index);
const metaKey = url => keyFor(url, 'meta');

async function readMeta(cache, url) {
  const hit = await cache.match(metaKey(url));
  return hit ? hit.json() : null;
}
async function writeMeta(cache, url, meta) {
  await cache.put(metaKey(url), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
}

/**
 * One aligned chunk. A cache hit comes back as bytes; a miss comes back as the network body, teed so
 * the player gets bytes as they arrive while the full chunk still lands in the cache. Waiting for
 * the whole megabyte before answering is what made a seek through the worker slower than none.
 */
async function chunk(request, url, index, cache) {
  const hit = await cache.match(chunkKey(url, index));
  if (hit) return { bytes: await hit.arrayBuffer(), meta: null };
  const start = index * CHUNK;
  const response = await fetch(new Request(request.url, { headers: { Range: `bytes=${start}-${start + CHUNK - 1}` }, credentials: 'include', cache: 'no-store' }));
  if (response.status !== 206) throw response;
  const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
  if (!total) throw response;
  const meta = { size: Number(total[1]), type: response.headers.get('Content-Type') || 'video/mp4', used: Date.now() };
  const length = Math.min(CHUNK, meta.size - start);
  const [toClient, toCache] = response.body.tee();
  cache.put(chunkKey(url, index), new Response(toCache, { headers: { 'Content-Type': meta.type, 'Content-Length': String(length) } }))
    .then(() => writeMeta(cache, url, meta))
    .then(() => notify({ type: 'footage-stored', url, index }))
    .catch(() => {});
  return { body: toClient, meta };
}

function notify(message) {
  self.clients.matchAll({ type: 'window' }).then(clients => { for (const client of clients) client.postMessage(message); }).catch(() => {});
}

async function serveRange(request, url, start, endInclusive) {
  const cache = await caches.open(CACHE);
  let meta = await readMeta(cache, url);
  const firstIndex = Math.floor(start / CHUNK);
  // The first chunk settles the file size when nothing is known yet; a miss there is also the
  // network telling us this URL does not answer ranges, in which case the caller passes through.
  const first = await chunk(request, url, firstIndex, cache);
  if (!meta) meta = first.meta;
  if (!meta) { first.body?.cancel().catch(() => {}); throw new Error('unsized'); }
  const size = meta.size;
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const end = Math.min(endInclusive ?? size - 1, size - 1);
  const lastIndex = Math.floor(end / CHUNK);
  if (Date.now() - (meta.used || 0) > 60000) writeMeta(cache, url, { ...meta, used: Date.now() }).catch(() => {});
  let index = firstIndex, ahead = first, next = lastIndex > firstIndex ? chunk(request, url, firstIndex + 1, cache) : null, reader = null;
  if (next) next.catch(() => {});
  const stream = new ReadableStream({
    async pull(controller) {
      if (index > lastIndex) { controller.close(); return; }
      let current;
      try { current = await ahead; } catch (error) { controller.error(error); return; }
      ahead = next; next = index + 2 <= lastIndex ? chunk(request, url, index + 2, cache) : null;
      if (next) next.catch(() => {});
      const from = index === firstIndex ? start - index * CHUNK : 0;
      const to = index === lastIndex ? end - index * CHUNK + 1 : CHUNK;
      if (current.bytes) controller.enqueue(new Uint8Array(current.bytes, from, Math.min(to, current.bytes.byteLength) - from));
      else {
        reader = current.body.getReader();
        let seen = 0;
        while (seen < to) {
          const { value, done } = await reader.read();
          if (done) break;
          const sliceFrom = Math.max(0, from - seen), sliceTo = Math.min(value.byteLength, to - seen);
          if (sliceTo > sliceFrom) controller.enqueue(value.subarray(sliceFrom, sliceTo));
          seen += value.byteLength;
        }
        // Stopping early leaves the tee's cache branch to finish draining on its own.
        if (seen >= to) reader.cancel().catch(() => {});
        reader = null;
      }
      index++;
    },
    cancel() { reader?.cancel().catch(() => {}); Promise.resolve(ahead).then(c => c?.body?.cancel()).catch(() => {}); Promise.resolve(next).then(c => c?.body?.cancel()).catch(() => {}); ahead = null; next = null; },
  });
  return new Response(stream, { status: 206, headers: {
    'Content-Type': meta.type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store',
  } });
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !MEDIA.test(url.pathname) || url.pathname.endsWith('/original')) return;
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') || '');
  if (!range) return;
  const key = url.pathname + url.search;
  event.respondWith(serveRange(request, key, Number(range[1]), range[2] ? Number(range[2]) : undefined).catch(() => fetch(request)));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'footage-clear') event.waitUntil(caches.delete(CACHE).then(() => notify({ type: 'footage-cleared' })));
});
