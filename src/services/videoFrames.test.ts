import test from 'node:test';
import assert from 'node:assert/strict';
import { aheadCount, createVideoFrames, displayIndex, isShownPicture } from './videoFrames.ts';

for (const [fps, bytes] of [[24, 960*540*1.5], [60, 1920*1080*4]]) test(`explicit decoding sustains ${fps} fps at ${bytes} bytes/frame, seeks safely and releases resources`,async()=>{
  const originals=['Worker','location'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)] as const);
  const allocated:Frame[]=[];
  class Frame {
    timestamp:number;duration=1e6/fps;codedWidth=1920;codedHeight=1080;closed=false;
    constructor(time:number){this.timestamp=Math.round(time*1e6);allocated.push(this);}
    allocationSize(){return bytes;}
    close(){this.closed=true;}
  }
  let worker:FakeWorker;
  class FakeWorker {
    onmessage?: (event:any)=>void;onerror?:unknown;terminated=false;generation=0;next=0;
    constructor(){worker=this;}
    postMessage(message:any){
      if(message.type==='open')return;
      if(message.type==='seek'){this.generation=message.generation;this.next=Math.floor(message.time*fps+1e-6);}
      for(let i=0;i<message.count;i++){
        const frame=new Frame(this.next++/fps),generation=message.generation;
        queueMicrotask(()=>this.onmessage?.({data:{type:'frame',frame,generation}}));
      }
    }
    terminate(){this.terminated=true;}
  }
  Object.defineProperty(globalThis,'Worker',{configurable:true,value:FakeWorker});
  Object.defineProperty(globalThis,'location',{configurable:true,value:{href:'https://editor.test/'}});
  const queue=createVideoFrames('/api/media/a/files/stream.mp4',fps,()=>{});
  const flush=async()=>{for(let i=0;i<4;i++)await new Promise(resolve=>setImmediate(resolve));};
  try{
    for(let i=0;i<fps*5;i++){
      const time=i/fps;queue.update(time);await flush();
      assert.ok(queue.frame(time),`No missing frame or pause/play refill at ${time}s`);
      if(i===0&&fps===60)assert.ok(queue.prepare(.01,1/24).some(frame=>frame===queue.frame(.01+1/24)),'Color preloads the next displayed picture even when source and timeline rates differ.');
      assert.ok(allocated.filter(frame=>!frame.closed).length<=Math.max(2,Math.min(24,Math.ceil(fps/2),Math.floor(32*1024**2/bytes))));
    }
    const oldGeneration=worker!.generation;
    queue.update(.25);await flush();
    assert.ok(Math.abs(queue.frame(.25)!.timestamp/1e6-.25)<1/fps);
    const obsolete=new Frame(5);worker!.onmessage!({data:{type:'frame',frame:obsolete,generation:oldGeneration}});
    assert.equal(obsolete.closed,true,'An obsolete seek result cannot replace the current picture.');
    assert.equal(queue.frame(30),undefined,'An old frame must not count as ready.');
    queue.dispose();assert.equal(worker!.terminated,true);assert.ok(allocated.every(frame=>frame.closed));
  }finally{
    queue.dispose();for(const [key,value] of originals){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}
  }
});

test('the colour look-ahead is a quarter second of display, within a byte budget, and never less than the next three pictures', () => {
  const bytes = 960 * 540 * 1.5;
  assert.equal(aheadCount(1 / 30, bytes), 8, 'a quarter second of a 30 fps timeline');
  assert.equal(aheadCount(1 / 60, bytes), 10, 'capped at ten pictures');
  assert.equal(aheadCount(1 / 30, 8_294_400), 3, 'large 10-bit pictures: the byte budget leaves only the next three');
  assert.equal(aheadCount(1 / 30, 0), 3, 'before the first picture lands the size is unknown');
  assert.equal(aheadCount(0.001, bytes), 10, 'a heavily slowed clip steps in tiny source increments');
});

test('a picture is one the clock will show only if the clock lands inside it', () => {
  // A 60 fps source on a 30 fps timeline: every second source picture is shown.
  const shown = [0, 1, 2, 3, 4, 5].map(k => isShownPicture(k / 60, (k + 1) / 60, 0, 1 / 30));
  assert.deepEqual(shown, [true, false, true, false, true, false]);
  // A clip slowed to 30 %: the clock moves 0.01 s a picture, so every source picture is shown.
  assert.deepEqual([0, 1, 2, 3].map(k => isShownPicture(k / 60, (k + 1) / 60, 0, .01)), [true, true, true, true]);
  assert.equal(isShownPicture(.5, .55, .52, 1 / 30), true, 'the picture the clock is inside now');
  // The display index counts clock steps to a picture: clamped at the one on screen, and a whole-microsecond start on a step is not a step late.
  assert.equal(displayIndex(.5, .52, 1 / 30), 0, 'a picture already under the clock is index 0, never negative');
  assert.deepEqual([0, 2, 4].map(k => displayIndex(Math.round(k / 60 * 1e6) / 1e6, 0, 1 / 30)), [0, 1, 2], 'microsecond rounding keeps a picture on its step');
});

test('pictures about to be shown are announced as they land, and prepare looks as deep as asked', async () => {
  const originals = ['Worker', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class Frame {
    timestamp: number; duration = 1e6 / 60; codedWidth = 960; codedHeight = 540; closed = false;
    constructor(time: number) { this.timestamp = Math.round(time * 1e6); }
    allocationSize() { return 960 * 540 * 1.5; }
    close() { this.closed = true; }
  }
  class FakeWorker {
    onmessage?: (event: any) => void; next = 0;
    postMessage(message: any) {
      if (message.type === 'open') return;
      if (message.type === 'seek') this.next = Math.floor(message.time * 60 + 1e-6);
      for (let i = 0; i < message.count; i++) {
        const frame = new Frame(this.next++ / 60), generation = message.generation;
        queueMicrotask(() => this.onmessage?.({ data: { type: 'frame', frame, generation } }));
      }
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://editor.test/' } });
  const announced: number[] = [];
  const queue = createVideoFrames('/api/media/a/files/stream.mp4', 60, () => {}, true, frame => announced.push(frame.timestamp));
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    queue.prepare(0, 1 / 30);   // the clock steps 1/30 s: only every second source picture is ever shown
    queue.update(0); await flush();
    assert.deepEqual(announced, [0, 2, 4, 6, 8, 10, 12, 14].map(k => Math.round(k / 60 * 1e6)), 'the eight shown pictures inside 0.25 s, none of the skipped ones');
    assert.equal(queue.prepare(0, 1 / 30).length, 3, 'the default look is the next three pictures, as before');
    const deep = queue.prepare(0, 1 / 30, true);
    assert.equal(deep.length, 8, 'a deep look names the eight shown pictures');
    assert.ok(deep.every((frame, i) => !i || frame.timestamp > deep[i - 1].timestamp), 'nearest first');
    const failing = createVideoFrames('/api/media/a/files/stream.mp4', 60, () => {}, true, () => { throw new Error('copy could not start'); });
    try {
      failing.prepare(0, 1 / 30); failing.update(0); await flush();
      assert.equal(failing.prepare(0, 1 / 30).length, 3, 'an arrival hook that throws leaves every picture in the queue');
    } finally { failing.dispose(); }
  } finally {
    queue.dispose(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});

// A 30 fps source on a 30 fps timeline, so every picture in the queue is shown and only the byte budget can stop the copies.
for (const [bytes, expected] of [[960 * 540 * 1.5, 8], [3_110_400, 5], [8_294_400, 3]]) test(`arrival copies stay inside the byte budget: ${bytes} B pictures announce ${expected}`, async () => {
  const originals = ['Worker', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  class Frame {
    timestamp: number; duration = 1e6 / 30; codedWidth = 1920; codedHeight = 1080; closed = false;
    constructor(time: number) { this.timestamp = Math.round(time * 1e6); }
    allocationSize() { return bytes; }
    close() { this.closed = true; }
  }
  class FakeWorker {
    onmessage?: (event: any) => void; next = 0;
    postMessage(message: any) {
      if (message.type === 'open') return;
      if (message.type === 'seek') this.next = Math.floor(message.time * 30 + 1e-6);
      for (let i = 0; i < message.count; i++) {
        const frame = new Frame(this.next++ / 30), generation = message.generation;
        queueMicrotask(() => this.onmessage?.({ data: { type: 'frame', frame, generation } }));
      }
    }
    terminate() {}
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://editor.test/' } });
  const announced: number[] = [];
  const queue = createVideoFrames('/api/media/a/files/stream.mp4', 30, () => {}, true, frame => announced.push(frame.timestamp));
  try {
    queue.prepare(0, 1 / 30);
    queue.update(0); for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(announced, Array.from({ length: expected }, (_, k) => Math.round(k / 30 * 1e6)), 'only the pictures aheadCount names are copied on arrival; the tick path picks up the rest');
    assert.equal(announced.length, aheadCount(1 / 30, bytes), 'arrival and prepare share one budget');
  } finally {
    queue.dispose(); for (const [key, value] of originals) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  }
});
