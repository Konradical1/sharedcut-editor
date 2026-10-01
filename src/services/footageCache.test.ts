import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const CHUNK = 1 << 20;
const pathOf = (key: string | Request) => { const url = new URL(typeof key === 'string' ? key : key.url, 'https://sharedcut.test'); return url.pathname + url.search; };
function harness({ badIndex = false, quota = false, status = 206, registrationFails = false, timedRanges = false, count = 4, failing = /$^/ } = {}) {
  const cache = new Map<string, Response>(), pending: { url: string; resolve: () => void; aborted: boolean }[] = [];
  const requests: { url: string; start: number }[] = [], ranges: [number, number][] = [], delays: number[] = [];
  let now = 1000, peak = 0, active = 0, calls = 0;
  const timers = new Map<number, () => void>(); let timer = 0;
  const handlers:Record<string,(event:any)=>void>={};
  const worker = { register: async () => { if (registrationFails) throw new Error('Worker blocked'); return {}; }, controller: {}, addEventListener(type:string,handler:(event:any)=>void) {handlers[type]=handler;} };
  const sandbox: any = {
    window: { caches: {} }, navigator: { serviceWorker: worker }, performance: { now: () => now },
    caches: { open: async () => ({ keys: async () => [...cache.keys()].map(key=>new Request(new URL(key,'https://sharedcut.test'))), match: async (key: string | Request) => cache.get(pathOf(key))?.clone(), delete: async (key: string | Request) => cache.delete(pathOf(key)) }), delete: async () => { cache.clear(); } },
    setTimeout: (fn: () => void, ms = 0) => { timers.set(++timer, fn); delays.push(ms); return timer; }, clearTimeout: (id: number) => timers.delete(id),
    Date: class extends Date { static now() { return now; } },
    AbortController, Error, Request, Response, URL, Uint8Array, JSON, Math,
    useSyncExternalStore: (subscribe: (listener: () => void) => void, snapshot: () => number) => { sandbox.subscribed?.forEach((listener: () => void) => subscribe(listener)); return snapshot(); },
    animatedSourceOffset: (clip: any, t: number) => clip.properties.freeze ? 0 : t,
    transitions: [], timelineTransitions: () => sandbox.transitions, moovExtent: () => 16, parseMp4Index: () => badIndex ? null : { moovEnd: 16 },
    byteRange: (_: unknown, from: number, to: number) => { ranges.push([from, to]); return { start: CHUNK, end: timedRanges && to <= 10 ? 2 * CHUNK : 3 * CHUNK }; },
    fetch: (url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      calls++; active++; peak = Math.max(peak, active);
      const start = Number(/bytes=(\d+)/.exec((options.headers as any).Range)![1]);
      requests.push({ url, start });
      const job = { url, aborted: false, resolve() {
        if (job.aborted) return;
        active--;
        const code = failing.test(url) ? 503 : status;
        if (!quota && code === 206) cache.set(`${url}?fc=${start / CHUNK}`, new Response(new Uint8Array(CHUNK), { headers: { 'Content-Length': String(CHUNK) } }));
        resolve(new Response(new Uint8Array(CHUNK), { status: code, headers: { 'Content-Range': `bytes ${start}-${start + CHUNK - 1}/${3 * CHUNK}` } }));
      } };
      options.signal!.addEventListener('abort', () => { job.aborted = true; active--; reject(options.signal!.reason); });
      pending.push(job);
    }),
  };
  const source = ts.transpileModule(readFileSync(new URL('./footageCache.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
  vm.runInNewContext(source + '\nglobalThis.api = { update, clipCached, clipFootageStatus, setDecoderStatus, clearFootageCache, retryFootage, preferLowStream, evict, useFootageVersion };', sandbox);
  const state = { timelineId: 't', projectId: 'p', playhead: 0, playing: false, settings: {},
    clips: Array.from({ length: count }, (_, i) => ({ id: `c${i}`, name: `Clip ${i}`, mediaId: `m${i}`, timelineId: 't', projectId: 'p', trackId: 'v', start: i * 10, duration: 5, sourceIn: 0, properties: {} as Record<string, unknown> })),
    tracks: [{ id: 'v', kind: 'video', timelineId: 't' }, { id: 'a', kind: 'audio', timelineId: 't' }] as any[],
    media: Array.from({ length: count }, (_, i) => ({ id: `m${i}`, name: `Clip ${i}`, kind: 'video', status: 'ready', proxyUrl: `/api/media/m${i}/files/stream.mp4` } as Record<string, unknown>)) };
  // Playback's selectedUrl: the picture file, or the separate sound file when asked for sound.
  const update = () => { now += 500; sandbox.api.update(state, { original: false, quality: 'Stream' }, (asset: any, visual: boolean) => visual ? asset.proxyUrl : asset.audioProxyUrl ?? asset.proxyUrl); };
  const drain = async (rounds = 12) => { for (let i = 0; i < rounds; i++) { pending.splice(0).forEach(job => job.resolve()); await flush(); } };
  const subscribe = (listener: () => void) => { sandbox.subscribed = [listener]; sandbox.api.useFootageVersion(); sandbox.subscribed = undefined; };
  const tick = () => { const due = [...timers.values()]; timers.clear(); due.forEach(fn => fn()); };
  return { ...sandbox.api as Record<'clipCached' | 'clipFootageStatus' | 'setDecoderStatus' | 'clearFootageCache' | 'retryFootage' | 'preferLowStream' | 'evict', any>, cache, saved:(url:string,index:number)=>{cache.set(`${url}?fc=${index}`,new Response('',{headers:{'Content-Length':String(CHUNK)}}));handlers.message({data:{cache:'footage-v3',type:'footage-stored',url,index,size:CHUNK}});}, meta:(url:string,used:number)=>cache.set(`${url}?fc=meta`,new Response(JSON.stringify({size:3*CHUNK,type:'video/mp4',used}))), transfer:(bytes:number,milliseconds:number)=>handlers.message({data:{cache:'footage-v3',type:'footage-transfer',bytes,milliseconds}}), state, sandbox, update, drain, subscribe, tick, delays, pending, requests, ranges, timers, advance: (ms: number) => { now += ms; }, recover: () => { badIndex = false; quota = false; status = 206; registrationFails = false; }, metrics: () => ({ peak, calls }) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test('cold start bounds indexes and chunks, reports real coverage, and cancels obsolete work', async () => {
  const h = harness();
  assert.equal(h.clipCached('c0'), false, 'untracked is never green');
  h.update(); await flush();
  assert.equal(h.pending.length, 4, 'one index read per file, all four files at once while paused');
  assert.match(h.pending[0].url, /m0/, 'playhead first');
  h.pending[0].resolve(); await flush();
  assert.equal(h.clipCached('c0'), false, 'index plus first chunk is not the clip');
  await h.drain(6);
  assert.equal(h.clipCached('c0'), true);
  assert.ok(h.metrics().peak <= 6);
  h.setDecoderStatus('c0', '/api/media/m0/files/stream.mp4', 'Decode failed', true);
  assert.equal(h.clipCached('c0'), true, 'decoder errors do not erase verified local bytes');
  assert.equal(h.clipFootageStatus('c0').state, 'green');
  assert.equal(h.clipFootageStatus('c0').playback.failed, true);
  assert.equal(h.clipFootageStatus('c0').playback.detail, 'Decode failed');
  await h.clearFootageCache(); h.update(); await flush();
  h.state.clips = []; h.update(); await flush();
  assert.ok(h.pending.every((job: any) => job.aborted), 'changing timeline cancels pending requests');
});

test('invalid indexes, HTTP failures, and failed cache writes stay non-green without a retry storm', async () => {
  for (const options of [{ badIndex: true }, { status: 503 }, { quota: true }]) {
    const h = harness(options); h.state.clips = h.state.clips.slice(0, 1); h.update(); await flush();
    h.pending.splice(0).forEach((job: any) => job.resolve()); await flush();
    h.pending.splice(0).forEach((job: any) => job.resolve()); await flush();
    assert.equal(h.clipCached('c0'), false);
    assert.match(h.clipFootageStatus('c0').detail, /retrying/);
    const calls = h.metrics().calls; await flush();
    assert.equal(h.metrics().calls, calls, 'failure waits for backoff');
    h.retryFootage(); await flush(); assert.ok(h.metrics().calls > calls);
    h.recover(); h.pending.splice(0).forEach((job: any) => job.resolve()); await flush();
    await h.drain(5);
    assert.equal(h.clipCached('c0'), true, 'successful retry clears stale failure status');
    await h.clearFootageCache();
  }
});

test('while playing, the playable windows of the current and next shots come before background bytes', async () => {
  const h = harness({ timedRanges: true, count: 8 }); h.state.playing = true; h.state.clips[0].duration = 100; h.state.clips[1].start = 1;
  h.update(); await flush();
  assert.equal(h.pending.length, 4, 'four files download at once while playing');
  assert.deepEqual(h.pending.slice(0, 2).map(job => /m\d/.exec(job.url)![0]), ['m0', 'm1'], 'current and next shot first');
  await h.drain(1);
  const next = h.requests.slice(4, 6).map(request => [/m\d/.exec(request.url)![0], request.start / CHUNK]);
  assert.deepEqual(next, [['m0', 1], ['m1', 1]], 'the urgent chunk of each near shot follows its index');
  await h.clearFootageCache();
});

test('paused prefetch uses six files at once and never two requests for one file', async () => {
  const h = harness({ count: 9 }); h.state.clips[8].mediaId = 'm0';
  h.update(); await flush();
  assert.equal(h.pending.length, 6);
  assert.equal(new Set(h.pending.map(job => job.url)).size, 6);
  await h.drain(20);
  assert.ok(h.state.clips.every(clip => h.clipCached(clip.id)));
  assert.ok(h.metrics().peak <= 6);
});

test('coverage counts the alpha WebM graphic and the separate sound file playback opens', async () => {
  const h = harness({ count: 4, failing: /m3\/files\/audio/ });
  const audio = (i: number) => `/api/media/m${i}/files/audio-v1.m4a`;
  for (const i of [0, 1, 2, 3]) Object.assign(h.state.media[i], { hasAudio: true, audioProxyUrl: audio(i) });
  h.state.media[1].proxyUrl = '/api/media/m1/files/proxy-half-alpha-v1.webm';
  h.state.clips[2].properties.reverse = true;
  h.update(); await h.drain(20);
  const urls = new Set(h.requests.map(request => request.url));
  assert.ok(urls.has(audio(0)), 'WebCodecs pictures play their sound from the audio proxy');
  assert.ok(!urls.has(audio(1)) && !urls.has(audio(2)), 'native <video> (WebM, reverse) carries its own sound');
  assert.deepEqual(h.requests.filter(request => /webm/.test(request.url)).map(request => request.start / CHUNK).sort(), [0, 0, 1, 2], 'the whole graphic is fetched');
  assert.equal(h.clipCached('c0'), true);
  assert.equal(h.clipCached('c1'), true, 'WebM graphics become green');
  assert.equal(h.clipCached('c3'), false, 'a missing sound file keeps the clip from turning green');
  assert.ok(h.cache.has('/api/media/m3/files/stream.mp4?fc=1'), 'even though its picture is saved');
  h.state.tracks[0].muted = true; h.update(); await h.drain(4);
  assert.equal(h.clipCached('c3'), true, 'a muted track does not need its sound');
});

test('transition handles borrow lead x speed of source, not eight times the lead', async () => {
  const h = harness({ count: 2 }); h.state.clips = [h.state.clips[1]]; Object.assign(h.state.clips[0], { sourceIn: 5 });
  h.sandbox.transitions = [{ incomingId: 'c1', outgoingId: 'c0', start: 9, end: 11 }];
  h.update(); await h.drain(4);
  const earliest = Math.min(...h.ranges.map(([from]) => from));
  assert.ok(earliest > 3 && earliest < 4, `range starts one second of handle before the in point, got ${earliest}`);
});

test('worker initialization failure is visible and a manual retry recovers', async()=>{
  const h=harness({registrationFails:true});h.update();await flush();
  assert.equal(h.clipFootageStatus('c0').state,'red');assert.match(h.clipFootageStatus('c0').detail,/Worker blocked/);
  h.recover();h.retryFootage();await flush();assert.ok(h.pending.length);
  await h.clearFootageCache();
});

test('automatic quality reacts to measured transfer capacity rather than cache-read speed',()=>{
  const h=harness();assert.equal(h.preferLowStream('/unknown.mp4'),false);
  h.transfer(CHUNK,4000);assert.equal(h.preferLowStream('/unknown.mp4'),true);
  h.transfer(CHUNK,1);assert.equal(h.preferLowStream('/unknown.mp4'),true,'An almost instantaneous response is not evidence of Internet throughput.');
  h.advance(25000);
  for(let i=0;i<6;i++){h.advance(100);h.transfer(CHUNK,100);}
  assert.equal(h.preferLowStream('/unknown.mp4'),false,'the slow sample has aged out');
});

test('parallel downloads are measured as the line they share, not as one slow request each',()=>{
  const h=harness();
  // Four 1 MiB chunks over the same second: 8 Mbit/s each, 33 Mbit/s of line.
  for(let i=0;i<4;i++)h.transfer(CHUNK,1000);
  assert.equal(h.preferLowStream('/unknown.mp4'),false);
  h.advance(25000);h.transfer(CHUNK,1000);
  assert.equal(h.preferLowStream('/unknown.mp4'),true,'one request a second on its own is a slow line');
});

test('a Stream file whose needed ranges are saved is never abandoned for the low stream', async () => {
  const h = harness(); h.state.clips = h.state.clips.slice(0, 2); h.update(); await flush();
  h.transfer(CHUNK, 4000);
  assert.equal(h.preferLowStream('/api/media/m0/files/stream.mp4'), true, 'slow link, nothing saved yet');
  await h.drain(6);
  assert.equal(h.clipCached('c0'), true);
  assert.equal(h.preferLowStream('/api/media/m0/files/stream.mp4'), false);
});

test('rolling cache evicts least recently used files first and keeps the current playable window',async()=>{
  const h=harness();h.state.clips=h.state.clips.slice(0,1);h.update();await h.drain(6);
  assert.equal(h.clipCached('c0'),true);
  const recent='/api/media/recent/files/stream.mp4',stale='/api/media/stale/files/stream.mp4';
  for(let i=0;i<1100;i++)h.saved(recent,i);
  for(let i=0;i<1100;i++)h.saved(stale,i);
  h.meta(recent,900_000);h.meta(stale,1000);
  await h.evict();
  const left=(url:string)=>[...h.cache.keys()].filter(key=>key.startsWith(`${url}?fc=`)&&!key.endsWith('meta')).length;
  assert.ok(left(recent)+left(stale)+3<=Math.ceil(2048*.8),'Eviction returns below the rolling budget.');
  assert.equal(left(recent),1100,'The recently used file is untouched while an older one can give bytes back.');
  assert.ok(left(stale)<1100);
  assert.equal(h.clipCached('c0'),true,'Current bytes remain usable.');
  await h.clearFootageCache();
});

test('startup lists the cache once instead of reading every chunk', async () => {
  const h = harness(); h.state.clips = h.state.clips.slice(0, 1);
  for (let i = 0; i < 3; i++) h.cache.set(`/api/media/m0/files/stream.mp4?fc=${i}`, new Response(''));
  let reads = 0; const open = h.sandbox.caches.open;
  h.sandbox.caches.open = async () => { const cache = await open(); return { ...cache, match: async (key: string) => { reads++; return cache.match(key); } }; };
  h.update(); await flush();
  assert.equal(reads, 0);
  h.pending.splice(0).forEach(job => job.resolve()); await flush();
  assert.equal(h.clipCached('c0'), true, 'chunks listed at startup count once the index is known');
});

test('UI hears at most four updates a second and only when something visible changed', async () => {
  const h = harness(); h.state.clips = h.state.clips.slice(0, 1);
  let heard = 0; h.subscribe(() => heard++);
  h.update(); await h.drain(6); h.tick(); heard = 0;
  for (let i = 0; i <= 50; i++) h.setDecoderStatus('c0', '/api/media/m0/files/stream.mp4', i % 2 ? undefined : 'Buffering video');
  h.tick(); assert.equal(heard, 1, 'a burst of changes is one notification');
  h.update(); h.update(); h.tick(); assert.equal(heard, 1, 'a refresh that changes nothing is silent');
  h.setDecoderStatus('c0', '/api/media/m0/files/stream.mp4', 'Decoding requested frame');
  assert.ok(h.delays.at(-1)! >= 200, 'the next notification waits out the quarter second');
  h.tick(); assert.equal(heard, 2);
});

/** Runs public/footage-worker.js against a counting fake Cache Storage and a range-serving origin. */
function worker(file: Buffer, memoryChunks?: number, line?: { wait: number; parts: number; gap: number }) {
  const listeners: Record<string, (event: any) => void> = {}, reads = new Map<string, number>(), messages: any[] = [];
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  // A real line: the first byte after `wait` ms of latency, then the body in `parts` pieces `gap` ms apart.
  const paced = (bytes: Uint8Array) => new ReadableStream({ async start(controller) {
    await sleep(line!.wait); const size = Math.ceil(bytes.length / line!.parts);
    for (let i = 0; i < bytes.length; i += size) { if (i) await sleep(line!.gap); controller.enqueue(bytes.slice(i, i + size)); }
    controller.close();
  } });
  // Like Chrome, a deleted cache lives on behind the Cache objects already opened on it; caches.open makes a new one.
  let store = new Map<string, ArrayBuffer>(), network = 0;
  const cacheOf = (entries: Map<string, ArrayBuffer>) => ({
    match: async (key: string) => { const path = pathOf(key); reads.set(path, (reads.get(path) ?? 0) + 1); const bytes = entries.get(path); return bytes && new Response(bytes.slice(0)); },
    put: async (key: string, response: Response) => { entries.set(pathOf(key), await response.arrayBuffer()); },
    keys: async () => [...entries.keys()].map(key => new Request(`https://sharedcut.test${key}`)),
    delete: async (key: string) => entries.delete(pathOf(key)),
  });
  const sandbox: Record<string, unknown> = {
    self: { addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (message: unknown) => messages.push(message) }] }, location: { origin: 'https://sharedcut.test' } },
    caches: { open: async () => cacheOf(store), delete: async () => { store = new Map(); return true; } },
    fetch: async (request: Request) => {
      network++;
      const [, from, to] = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range')!)!, start = Number(from), end = Math.min(file.length - 1, to ? Number(to) : file.length - 1);
      const body = new Uint8Array(file.subarray(start, end + 1));
      return new Response(line ? paced(body) : body, { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${file.length}` } });
    },
    Request, Response, Headers, URL, ReadableStream, TransformStream, Uint8Array, Date, Math, Number, JSON, Promise, Error, RegExp, performance,
  };
  let source = readFileSync(new URL('../../public/footage-worker.js', import.meta.url), 'utf8');
  if (memoryChunks) { assert.match(source, /const MEMORY = [^;]+;/); source = source.replace(/const MEMORY = [^;]+;/, `const MEMORY = ${memoryChunks} * CHUNK;`); }
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const request = async (path: string, range: string, headers: Record<string, string> = {}) => {
    const event = { request: new Request(`https://sharedcut.test${path}`, { headers: { Range: range, ...headers } }), response: undefined as Promise<Response> | undefined, respondWith(value: Promise<Response>) { this.response = value; } };
    listeners.fetch(event);
    return Buffer.from(await (await event.response!).arrayBuffer());
  };
  const seed = (path: string) => {
    for (let i = 0; i * CHUNK < file.length; i++) store.set(`${path}?fc=${i}`, new Uint8Array(file.subarray(i * CHUNK, (i + 1) * CHUNK)).buffer);
    store.set(`${path}?fc=meta`, new TextEncoder().encode(JSON.stringify({ size: file.length, type: 'video/mp4', used: Date.now() })).buffer as ArrayBuffer);
  };
  return { request, seed, get store() { return store; }, messages, deleteCache: () => { store = new Map(); }, message: (data: unknown, ports: unknown[] = []) => new Promise<void>(resolve => listeners.message({ data, ports, source: { id: 'c' }, waitUntil: (work: Promise<unknown>) => void work.then(() => resolve()) })), network: () => network, reads: (key: string) => reads.get(key) ?? 0 };
}

test('decoder-sized reads slice one in-memory chunk instead of rereading a megabyte each time', async () => {
  const file = randomBytes(3 * CHUNK + 123), sw = worker(file), path = '/api/media/hot/files/stream.mp4';
  sw.seed(path);
  const ranges = Array.from({ length: 12 }, (_, i) => [CHUNK + i * 65536, CHUNK + (i + 1) * 65536 - 1]);
  const bodies = await Promise.all(ranges.map(([start, end]) => sw.request(path, `bytes=${start}-${end}`)));
  bodies.forEach((body, i) => assert.ok(body.equals(file.subarray(ranges[i][0], ranges[i][1] + 1)), `range ${i} is exact`));
  const spanning = await sw.request(path, `bytes=${2 * CHUNK - 10}-${2 * CHUNK + 9}`);
  assert.ok(spanning.equals(file.subarray(2 * CHUNK - 10, 2 * CHUNK + 10)), 'a read across a chunk boundary joins both');
  assert.equal(sw.reads(`${path}?fc=1`), 1, 'twelve concurrent readers shared one Cache Storage read');
  for (let i = 0; i < 5; i++) await sw.request(path, `bytes=${CHUNK + 5}-${CHUNK + 100}`);
  assert.equal(sw.reads(`${path}?fc=1`), 1, 'later reads come from memory');
  assert.equal(sw.reads(`${path}?fc=meta`), 1, 'the size is not reread per request once known');
  const tail = await sw.request(path, `bytes=${3 * CHUNK}-`);
  assert.ok(tail.equals(file.subarray(3 * CHUNK)), 'the short last chunk ends at the file end');
  assert.equal(sw.network(), 0);
});

test('a network chunk is served from memory afterwards and memory stays within its budget', async () => {
  const file = randomBytes(4 * CHUNK), sw = worker(file, 2), path = '/api/media/cold/files/stream.mp4';
  assert.ok((await sw.request(path, 'bytes=100-200')).equals(file.subarray(100, 201)));
  for (let i = 0; i < 50 && !sw.store.has(`${path}?fc=meta`); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const before = sw.reads(`${path}?fc=0`);
  assert.ok((await sw.request(path, 'bytes=300-400')).equals(file.subarray(300, 401)));
  assert.equal(sw.reads(`${path}?fc=0`), before, 'the downloaded chunk stayed in memory');
  assert.equal(sw.network(), 1);
  for (const index of [1, 2, 3]) await sw.request(path, `bytes=${index * CHUNK}-${index * CHUNK + 10}`);
  for (let i = 0; i < 50 && sw.network() < 4; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 20));
  await sw.request(path, 'bytes=0-10');
  assert.equal(sw.reads(`${path}?fc=0`), before + 1, 'the oldest chunk left memory once the budget was reached');
  await sw.message({ type: 'footage-clear' });
  assert.equal(sw.store.size, 0);
  assert.ok((await sw.request(path, 'bytes=0-10')).equals(file.subarray(0, 11)));
  assert.equal(sw.network(), 5, 'clearing the cache also forgets the in-memory copy');
});

test('a chunk the page evicted while the worker still holds it in memory is saved again when prefetched', async () => {
  const file = randomBytes(2 * CHUNK), sw = worker(file), path = '/api/media/evicted/files/stream.mp4';
  sw.seed(path);
  assert.ok((await sw.request(path, 'bytes=0-100')).equals(file.subarray(0, 101)), 'chunk 0 is now in memory');
  sw.store.delete(`${path}?fc=0`);
  assert.ok((await sw.request(path, `bytes=0-${CHUNK - 1}`, { 'X-Footage-Prefetch': '1' })).equals(file.subarray(0, CHUNK)));
  assert.ok(sw.store.has(`${path}?fc=0`), 'the prefetch put the evicted chunk back in Cache Storage');
  assert.equal(sw.network(), 0, 'from memory, not downloaded again');
  await flush();
  assert.ok(sw.messages.some(message => message.type === 'footage-stored' && message.url === path && message.index === 0), 'the page hears it is saved');
});

test('after something else deletes the cache, downloads land in the live cache rather than the deleted one', async () => {
  const file = randomBytes(3 * CHUNK), sw = worker(file), path = '/api/media/gone/files/stream.mp4';
  await sw.request(path, 'bytes=0-10');
  for (let i = 0; i < 50 && !sw.store.has(`${path}?fc=meta`); i++) await new Promise(resolve => setTimeout(resolve, 5));
  sw.deleteCache();
  await sw.request(path, `bytes=${CHUNK}-${CHUNK + 10}`);
  for (let i = 0; i < 50 && !sw.store.has(`${path}?fc=1`); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(sw.store.has(`${path}?fc=1`), 'the chunk was saved where the page will look for it');
  assert.ok(sw.store.has(`${path}?fc=meta`));
});

test('the urgent window of an incoming clip starts at its transition handle, not at its cut', async () => {
  const h = harness({ count: 2 }); h.state.clips = [h.state.clips[1]]; Object.assign(h.state.clips[0], { sourceIn: 5, duration: 30 });
  h.sandbox.transitions = [{ incomingId: 'c1', outgoingId: 'c0', start: 8, end: 12 }];
  h.update(); await h.drain(2);
  // A 2 s lead at speed 1 plays source from 3 s when the transition starts; 10 s of window from there.
  assert.ok(h.ranges.some(([from, to]) => Math.abs(from - 2.5) < 1e-9 && Math.abs(to - 13) < 1e-9), JSON.stringify(h.ranges));
});

test('the low stream is declined while the next seconds of a Stream file are saved, whatever is missing later', async () => {
  const h = harness({ timedRanges: true }), url = '/api/media/m0/files/stream.mp4';
  h.state.clips = [h.state.clips[0]]; h.state.clips[0].duration = 100;
  h.update(); await flush();
  h.pending.splice(0).forEach(job => job.resolve()); await flush();
  h.saved(url, 0); h.saved(url, 1); h.transfer(CHUNK, 4000);
  assert.equal(h.clipCached('c0'), false, 'the rest of the clip is not saved');
  assert.equal(h.preferLowStream(url), false, 'header and the window from the playhead are saved');
  h.state.playhead = 50; h.update();
  assert.equal(h.preferLowStream(url), true, 'further on, the window reaches bytes that are not saved');
});

const lowStreams = (h: ReturnType<typeof harness>) => { for (const asset of h.state.media) asset.proxyVariants = { Stream: asset.proxyUrl, StreamLow: String(asset.proxyUrl).replace('stream', 'low') }; };
test('on a slow line the prefetcher fetches the low stream a new decoder will open, two downloads at a time', async () => {
  const h = harness({ count: 6 }); lowStreams(h);
  h.transfer(CHUNK, 4000); h.update(); await flush();
  assert.equal(h.pending.length, 2, 'a slow line gets two downloads at once, not six');
  await h.drain(30);
  assert.ok(h.requests.length && h.requests.every(request => /low\.mp4/.test(request.url)), 'no Stream bytes');
  assert.equal(h.clipCached('c0'), true, 'green means the file playback will open is saved');
  assert.equal(h.preferLowStream('/api/media/m0/files/stream.mp4'), true, 'and a new decoder is steered to it');
});

test('a fast line, or Stream bytes saved before, keeps the Stream file planned', async () => {
  const fast = harness({ count: 1 }); lowStreams(fast);
  for (let i = 0; i < 4; i++) fast.transfer(CHUNK, 100);
  fast.update(); await fast.drain(6);
  assert.ok(fast.requests.every(request => /stream\.mp4/.test(request.url)));
  const slow = harness({ count: 1 }), url = '/api/media/m0/files/stream.mp4'; lowStreams(slow);
  for (const i of [0, 1, 2]) slow.saved(url, i);
  slow.transfer(CHUNK, 4000); slow.update(); await slow.drain(2); slow.update(); await slow.drain(2);
  assert.ok(slow.requests.every(request => request.url === url), 'only the saved index is read, served from the cache');
  assert.equal(slow.clipCached('c0'), true);
  assert.equal(slow.preferLowStream(url), false);
});

test('the worker times how fast a chunk body arrived, not the wait for its first byte', async () => {
  const sw = worker(randomBytes(CHUNK), undefined, { wait: 300, parts: 5, gap: 40 }), path = '/api/media/latent/files/stream.mp4';
  await sw.request(path, 'bytes=0-10');
  for (let i = 0; i < 100 && !sw.messages.some(message => message.type === 'footage-transfer'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  const { bytes, milliseconds, ago } = sw.messages.find(message => message.type === 'footage-transfer');
  assert.equal(bytes, CHUNK);
  // Four 40 ms gaps carry four fifths of the chunk: ~200 ms at that speed. Counting the 300 ms wait would read ~500.
  assert.ok(milliseconds >= 150 && milliseconds < 380, `body time ${milliseconds} ms`);
  assert.ok(ago >= 0 && ago < 200);
});

test('before any footage, the page\'s own large downloads say how fast the line is, until footage measures it', () => {
  const page = (bodies: [number, number][]) => {
    const h = harness(); h.sandbox.location = { origin: 'https://sharedcut.test' };
    h.sandbox.performance.getEntriesByType = () => bodies.map(([bytes, seconds]) => ({ name: 'https://sharedcut.test/api/state', transferSize: bytes, encodedBodySize: bytes, responseStart: 100, responseEnd: 100 + seconds * 1000 }));
    h.update(); return h;
  };
  // Project state of 5 MB in 4 s: a 10 Mbit/s line, too slow for an unknown Stream file.
  assert.equal(page([[5e6, 4]]).preferLowStream('/unknown.mp4'), true);
  assert.equal(page([[5e6, 4], [1e6, .01]]).preferLowStream('/unknown.mp4'), true, 'a body that arrived at once is not the line');
  assert.equal(page([[5e6, .5]]).preferLowStream('/unknown.mp4'), false, '80 Mbit/s');
  assert.equal(page([[600_000, 4]]).preferLowStream('/unknown.mp4'), false, 'a small page proves nothing');
  const h = page([[5e6, .5]]);
  for (let i = 0; i < 15; i++) { h.advance(1000); h.transfer(CHUNK, 1000); }
  assert.equal(h.preferLowStream('/unknown.mp4'), false, 'a few slow chunks can be the page still loading beside them');
  h.advance(1000); h.transfer(CHUNK, 1000);
  assert.equal(h.preferLowStream('/unknown.mp4'), true, '16 MiB of footage at 8 Mbit/s outweighs the page');
});
