import test from 'node:test';
import assert from 'node:assert/strict';
import { createVideoFrames } from './videoFrames.ts';

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
