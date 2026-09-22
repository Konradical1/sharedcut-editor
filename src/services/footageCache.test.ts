import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const CHUNK = 1 << 20;
function harness({ badIndex = false, quota = false, status = 206, registrationFails = false, timedRanges = false } = {}) {
  const cache = new Map<string, Response>(), pending: { url: string; resolve: () => void; aborted: boolean }[] = [];
  let now = 1000, peak = 0, active = 0, calls = 0;
  const timers = new Map<number, () => void>(); let timer = 0;
  const handlers:Record<string,(event:any)=>void>={};
  const worker = { register: async () => { if (registrationFails) throw new Error('Worker blocked'); return {}; }, controller: {}, addEventListener(type:string,handler:(event:any)=>void) {handlers[type]=handler;} };
  const sandbox: any = {
    window: { caches: {} }, navigator: { serviceWorker: worker }, performance: { now: () => now },
    caches: { open: async () => ({ keys: async () => [...cache.keys()].map(key=>new Request(new URL(key,'https://sharedcut.test'))), match: async (key: string) => cache.get(key)?.clone(), delete: async (request:Request) => {const url=new URL(request.url);return cache.delete(url.pathname+url.search);} }), delete: async () => { cache.clear(); } },
    setTimeout: (fn: () => void) => { timers.set(++timer, fn); return timer; }, clearTimeout: (id: number) => timers.delete(id),
    Date: class extends Date { static now() { return now; } },
    AbortController, Error, Request, Response, URL, Uint8Array, useSyncExternalStore() {},
    animatedSourceOffset: (clip: any, t: number) => clip.properties.freeze ? 0 : t,
    timelineTransitions: () => [], moovExtent: () => 16, parseMp4Index: () => badIndex ? null : { moovEnd: 16 },
    byteRange: (_: unknown, from: number, to: number) => ({ start: CHUNK, end: timedRanges && to <= 10 ? 2 * CHUNK : 3 * CHUNK }),
    fetch: (url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
      calls++; active++; peak = Math.max(peak, active);
      const start = Number(/bytes=(\d+)/.exec((options.headers as any).Range)![1]);
      const job = { url, aborted: false, resolve() {
        if (job.aborted) return;
        active--;
        if (!quota) cache.set(`${url}?fc=${start / CHUNK}`, new Response(new Uint8Array(CHUNK), { headers: { 'Content-Length': String(CHUNK) } }));
        resolve(new Response(new Uint8Array(CHUNK), { status, headers: { 'Content-Range': `bytes ${start}-${start + CHUNK - 1}/${3 * CHUNK}` } }));
      } };
      options.signal!.addEventListener('abort', () => { job.aborted = true; active--; reject(options.signal!.reason); });
      pending.push(job);
    }),
  };
  const source = ts.transpileModule(readFileSync(new URL('./footageCache.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/^import .*;\n/gm, '').replace(/\bexport /g, '');
  vm.runInNewContext(source + '\nglobalThis.api = { update, clipCached, clipFootageStatus, setDecoderStatus, clearFootageCache, retryFootage, preferLowStream, evict };', sandbox);
  const state = { timelineId: 't', projectId: 'p', playhead: 0, playing: false, settings: {},
    clips: Array.from({ length: 4 }, (_, i) => ({ id: `c${i}`, name: `Clip ${i}`, mediaId: `m${i}`, timelineId: 't', projectId: 'p', trackId: 'v', start: i * 10, duration: 5, sourceIn: 0, properties: {} })),
    tracks: [{ id: 'v', kind: 'video' }], media: Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, name: `Clip ${i}`, kind: 'video', status: 'ready', proxyUrl: `/api/media/m${i}/files/stream.mp4` })) };
  const update = () => { now += 500; sandbox.api.update(state, { original: false }, (asset: any) => asset.proxyUrl); };
  return { ...sandbox.api, cache, saved:(url:string,index:number)=>{cache.set(`${url}?fc=${index}`,new Response('',{headers:{'Content-Length':String(CHUNK)}}));handlers.message({data:{cache:'footage-v3',type:'footage-stored',url,index,size:CHUNK}});}, transfer:(bytes:number,milliseconds:number)=>handlers.message({data:{cache:'footage-v3',type:'footage-transfer',bytes,milliseconds}}), state, update, pending, timers, recover: () => { badIndex = false; quota = false; status = 206; registrationFails = false; }, metrics: () => ({ peak, calls }) };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test('cold start bounds indexes and chunks, reports real coverage, and cancels obsolete work', async () => {
  const h = harness();
  assert.equal(h.clipCached('c0'), false, 'untracked is never green');
  h.update(); await flush();
  assert.equal(h.pending.length, 2, 'metadata obeys the same concurrency budget');
  assert.match(h.pending[0].url, /m0/, 'playhead first');
  h.pending[0].resolve(); await flush();
  assert.equal(h.clipCached('c0'), false, 'index plus first chunk is not the clip');
  for (let i = 0; i < 6; i++) { h.pending.splice(0).forEach((job: any) => job.resolve()); await flush(); }
  assert.equal(h.clipCached('c0'), true);
  assert.equal(h.metrics().peak, 2);
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
    for (let i = 0; i < 5; i++) { h.pending.splice(0).forEach((job: any) => job.resolve()); await flush(); }
    assert.equal(h.clipCached('c0'), true, 'successful retry clears stale failure status');
    await h.clearFootageCache();
  }
});


test('next cut gets a playable window before the current long clip is downloaded in full', async () => {
  const h=harness({timedRanges:true});h.state.playing=true;h.state.clips[0].duration=100;h.state.clips[1].start=1;
  h.update();await flush();
  for(let i=0;i<2;i++){const job=h.pending.shift();assert.match(job!.url,/m0/);job!.resolve();await flush();}
  assert.match(h.pending[0].url,/m1/,'Read the next shot index before the rest of the long current clip.');
  await h.clearFootageCache();
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

test('rolling cache evicts distant bytes while retaining the current playable window',async()=>{
  const h=harness();h.state.clips=h.state.clips.slice(0,1);h.update();await flush();
  for(let i=0;i<4;i++){h.pending.splice(0).forEach((job:any)=>job.resolve());await flush();}
  assert.equal(h.clipCached('c0'),true);
  for(let i=0;i<2100;i++)h.saved('/api/media/old/files/stream.mp4',i);
  await h.evict();
  assert.ok(h.cache.size<=Math.ceil(2048*.8),'Eviction returns below the rolling budget.');
  assert.equal(h.clipCached('c0'),true,'Current bytes remain usable.');
  await h.clearFootageCache();
});
