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
  const update = () => { now += 500; sandbox.api.update(state, { original: false }, (asset: any, visual: boolean) => visual ? asset.proxyUrl : asset.audioProxyUrl ?? asset.proxyUrl); };
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
  for(let i=0;i<6;i++)h.transfer(CHUNK,100);
  assert.equal(h.preferLowStream('/unknown.mp4'),false);
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
function worker(file: Buffer, memoryChunks?: number) {
  const listeners: Record<string, (event: any) => void> = {}, store = new Map<string, ArrayBuffer>(), reads = new Map<string, number>();
  let network = 0;
  const cache = {
    match: async (key: string) => { const path = pathOf(key); reads.set(path, (reads.get(path) ?? 0) + 1); const bytes = store.get(path); return bytes && new Response(bytes.slice(0)); },
    put: async (key: string, response: Response) => { store.set(pathOf(key), await response.arrayBuffer()); },
    keys: async () => [...store.keys()].map(key => new Request(`https://sharedcut.test${key}`)),
    delete: async (key: string) => store.delete(pathOf(key)),
  };
  const sandbox: Record<string, unknown> = {
    self: { addEventListener: (type: string, fn: (event: any) => void) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => {}, matchAll: async () => [] }, location: { origin: 'https://sharedcut.test' } },
    caches: { open: async () => cache, delete: async () => { store.clear(); return true; } },
    fetch: async (request: Request) => {
      network++;
      const [, from, to] = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('Range')!)!, start = Number(from), end = Math.min(file.length - 1, to ? Number(to) : file.length - 1);
      return new Response(new Uint8Array(file.subarray(start, end + 1)), { status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': `bytes ${start}-${end}/${file.length}` } });
    },
    Request, Response, Headers, URL, ReadableStream, TransformStream, Uint8Array, Date, Math, Number, JSON, Promise, Error, RegExp, performance,
  };
  let source = readFileSync(new URL('../../public/footage-worker.js', import.meta.url), 'utf8');
  if (memoryChunks) { assert.match(source, /const MEMORY = [^;]+;/); source = source.replace(/const MEMORY = [^;]+;/, `const MEMORY = ${memoryChunks} * CHUNK;`); }
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const request = async (path: string, range: string) => {
    const event = { request: new Request(`https://sharedcut.test${path}`, { headers: { Range: range } }), response: undefined as Promise<Response> | undefined, respondWith(value: Promise<Response>) { this.response = value; } };
    listeners.fetch(event);
    return Buffer.from(await (await event.response!).arrayBuffer());
  };
  const seed = (path: string) => {
    for (let i = 0; i * CHUNK < file.length; i++) store.set(`${path}?fc=${i}`, new Uint8Array(file.subarray(i * CHUNK, (i + 1) * CHUNK)).buffer);
    store.set(`${path}?fc=meta`, new TextEncoder().encode(JSON.stringify({ size: file.length, type: 'video/mp4', used: Date.now() })).buffer as ArrayBuffer);
  };
  return { request, seed, store, message: (data: unknown, ports: unknown[] = []) => new Promise<void>(resolve => listeners.message({ data, ports, source: { id: 'c' }, waitUntil: (work: Promise<unknown>) => void work.then(() => resolve()) })), network: () => network, reads: (key: string) => reads.get(key) ?? 0 };
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
