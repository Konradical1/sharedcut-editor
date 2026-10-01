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
 *
 * Decoders read ~64 KiB at a time, several layers at once. Recently used chunks therefore also stay
 * in memory, so each read is a slice rather than another megabyte out of Cache Storage.
 */
const CACHE = 'footage-v3';
const pending = new Map();
const disabledClients = new Set();
const CHUNK = 1 << 20;
const MEDIA = /^\/api\/.+\.(mp4|m4a|mov|webm)$/i;
// ponytail: fixed budget of hot chunks; the browser drops it whenever it stops an idle worker.
const MEMORY = 80 * CHUNK;
// Least recently used first (Map order). `reading` dedupes concurrent Cache Storage reads of one chunk.
const memory = new Map(), reading = new Map(), metas = new Map();
let memoryBytes = 0, epoch = 0, opened;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(Promise.all([self.clients.claim(), caches.delete('footage-v1'), caches.delete('footage-v2')])));

const keyFor = (url, marker) => `${url}${url.includes('?') ? '&' : '?'}fc=${marker}`;
const chunkKey = (url, index) => keyFor(url, index);
const metaKey = url => keyFor(url, 'meta');
const open = () => opened ??= reopen();
// Every write opens the cache afresh: a Cache object outlives caches.delete() by anyone else, and puts into it are lost.
const reopen = () => opened = caches.open(CACHE).catch(error => { opened = undefined; throw error; });

function keep(key, bytes) {
  const old = memory.get(key);
  if (old) { memory.delete(key); memoryBytes -= old.byteLength; }
  memory.set(key, bytes); memoryBytes += bytes.byteLength;
  for (const [oldest, value] of memory) { if (memoryBytes <= MEMORY) break; memory.delete(oldest); memoryBytes -= value.byteLength; }
}
/** Saved chunk bytes, or null. One Cache Storage read per chunk however many readers ask at once. */
function cached(cache, key) {
  const hot = memory.get(key);
  if (hot) { memory.delete(key); memory.set(key, hot); return hot; }
  let job = reading.get(key);
  if (!job) {
    const at = epoch;
    job = cache.match(key).then(hit => hit ? hit.arrayBuffer() : null).then(bytes => { if (bytes && at === epoch) keep(key, bytes); return bytes; }).finally(() => reading.delete(key));
    reading.set(key, job);
  }
  return job;
}

/** File size and type. Held in memory once known; a missing entry is looked up again next time. */
function readMeta(cache, url) {
  if (metas.has(url)) return metas.get(url);
  const job = cache.match(metaKey(url)).then(hit => hit ? hit.json() : null).catch(() => null).then(meta => { if (!meta && metas.get(url) === job) metas.delete(url); return meta; });
  metas.set(url, job);
  return job;
}
async function writeMeta(cache, url, meta) {
  metas.set(url, meta);
  await cache.put(metaKey(url), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
}

/**
 * One aligned chunk. A cache hit comes back as bytes; a miss comes back as the network body, teed so
 * the player gets bytes as they arrive while the full chunk still lands in the cache. Waiting for
 * the whole megabyte before answering is what made a seek through the worker slower than none.
 */
async function chunk(request, url, index, cache, prefetch = false) {
  const key = chunkKey(url, index);
  const bytes = pending.has(key) ? null : await cached(cache, key);
  if (bytes) {
    const meta = await readMeta(cache, url);
    // The page prefetches only chunks its store lacks, yet memory can still hold one it evicted: save that copy again.
    return { bytes, meta, saved: prefetch ? persist(url, index, key, bytes, meta) : undefined };
  }
  let job = pending.get(key);
  if (!job) {
    job = (async () => {
      const start = index * CHUNK;
      const response = await fetch(new Request(request.url, { headers: { Range: `bytes=${start}-${start + CHUNK - 1}` }, credentials: 'include', cache: 'no-store' }));
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
      if (response.status !== 206 || !range || Number(range[1]) !== start || Number(range[2]) !== Math.min(start + CHUNK, Number(range[3])) - 1) throw new Error('Invalid media range');
      const meta = { size: Number(range[3]), type: response.headers.get('Content-Type') || 'video/mp4', used: Date.now() };
      const length = Math.min(CHUNK, meta.size - start), whole = new Uint8Array(length), at = epoch;
      let received = 0, firstAt = 0, firstSize = 0, lastAt = 0;
      const checked = new Response(response.body.pipeThrough(new TransformStream({
        transform(bytes, controller) {
          if (received + bytes.byteLength > length) throw new Error('Oversized media range');
          if (!received) { firstAt = performance.now(); firstSize = bytes.byteLength; }
          whole.set(bytes, received); received += bytes.byteLength; lastAt = performance.now(); controller.enqueue(bytes);
        },
        flush() { if (received !== length) throw new Error('Incomplete media range'); },
      })), { headers: { 'Content-Type': meta.type, 'Content-Length': String(length) } });
      // All simultaneous readers share this network request. Keep at most one aligned chunk
      // buffered for late readers; the first reader still receives bytes as they arrive.
      const copy = checked.clone();
      const saved = reopen().then(store => store.put(key, copy).then(() => writeMeta(store, url, meta))).then(() => {
        if (at === epoch) keep(key, whole.buffer);
        notify({ type: 'footage-stored', url, index, size: length });
        // Line speed is how fast the body arrived, first byte to last; the wait for the first byte is latency, and
        // counting it read a lightly used fast line as a slow one. Scaled so bytes / milliseconds is that speed.
        notify({ type: 'footage-transfer', bytes: length, milliseconds: (lastAt - firstAt) * length / Math.max(1, length - firstSize), ago: performance.now() - lastAt });
      }).catch(error => { notify({ type: 'footage-storage-error', url }); throw error; });
      saved.catch(() => {});
      void saved.finally(() => { pending.delete(key); checked.body.cancel().catch(() => {}); }).catch(() => {});
      return { response: checked, meta, saved };
    })();
    pending.set(key, job);
    job.catch(() => pending.delete(key));
  }
  const result = await job;
  return { body: result.response.clone().body, meta: result.meta, saved: result.saved };
}

/** Writes a chunk held in memory back to Cache Storage if the store no longer has it. */
async function persist(url, index, key, bytes, meta) {
  const store = await reopen();
  if (await store.match(key)) return;
  await store.put(key, new Response(bytes.slice(0), { headers: { 'Content-Type': meta?.type || 'video/mp4', 'Content-Length': String(bytes.byteLength) } }));
  if (meta) await writeMeta(store, url, meta);
  notify({ type: 'footage-stored', url, index, size: bytes.byteLength });
}

function notify(message) {
  self.clients.matchAll({ type: 'window' }).then(clients => { for (const client of clients) client.postMessage({ ...message, cache: CACHE }); }).catch(() => {});
}

async function serveRange(request, url, start, endInclusive) {
  const cache = await open();
  let meta = await readMeta(cache, url);
  const firstIndex = Math.floor(start / CHUNK);
  // The first chunk settles the file size when nothing is known yet; a miss there is also the
  // network telling us this URL does not answer ranges, in which case the caller passes through.
  const prefetch = request.headers.get('X-Footage-Prefetch') === '1';
  const first = await chunk(request, url, firstIndex, cache, prefetch);
  if (!meta) meta = first.meta;
  if (prefetch) await first.saved;
  if (!meta) { first.body?.cancel().catch(() => {}); throw new Error('unsized'); }
  const size = meta.size;
  if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const end = Math.min(endInclusive ?? size - 1, size - 1);
  const lastIndex = Math.floor(end / CHUNK);
  // Last use per file, for the page's eviction order.
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
      // A copy of just the asked-for bytes: the chunk in memory must stay whole for the next reader.
      if (current.bytes) controller.enqueue(new Uint8Array(current.bytes.slice(from, Math.min(to, current.bytes.byteLength))));
      else {
        reader = current.body.getReader();
        let seen = 0;
        while (seen < to) {
          const { value, done } = await reader.read();
          if (done) { if (seen < to) throw new Error('Incomplete media range'); break; }
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
  if (request.method !== 'GET' || disabledClients.has(event.clientId) || request.headers.get('X-Footage-Cache') === 'off') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !MEDIA.test(url.pathname) || url.pathname.endsWith('/original')) return;
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range') || '');
  if (!range) return;
  const key = url.pathname + url.search;
  event.respondWith(serveRange(request, key, Number(range[1]), range[2] ? Number(range[2]) : undefined).catch(() => fetch(request)));
});

self.addEventListener('message', event => {
  if (event.data?.type === 'footage-enabled' && event.source?.id) {
    if (event.data.enabled) disabledClients.delete(event.source.id); else disabledClients.add(event.source.id);
  }
  if (event.data?.type === 'footage-clear') event.waitUntil(
    Promise.allSettled([...pending.values()].map(job => job.then(result => result.saved)))
      .then(() => caches.delete(CACHE))
      .then(() => {
        epoch++; opened = undefined; memory.clear(); memoryBytes = 0; metas.clear();
        notify({ type: 'footage-cleared' }); event.ports?.[0]?.postMessage({ cleared: true });
      })
  );
});
