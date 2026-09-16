import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameLineServer } from './index.ts';
import { stateDelta, applyStateDelta, shareState } from '../src/services/stateDelta.ts';
import type { PersistedState } from '../src/services/index.ts';

test('five clients receive pushed previews and incremental edits without losing authorization or history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frameline-realtime-'));
  const app = createFrameLineServer({ dataDir: dir });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(app.server.address() as {port: number}).port}/api`;
  const streams: AbortController[] = [];
  const clients: {cookie: string; id: string}[] = [];
  const request = async (client: number, path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { cookie: clients[client]?.cookie ?? '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  try {
    for (let i = 0; i < 5; i++) {
      const signup = await request(i, '/auth/signup', 'POST', { name: `Editor ${i}`, email: `editor${i}@example.test`, password: 'realtime-test-password' });
      assert.equal(signup.status, 201);
      clients.push({ cookie: signup.headers.get('set-cookie')!.split(';')[0], id: signup.data.user.id });
    }
    const initial = (await request(0, '/state')).data;
    const project = (id: string, shared: boolean) => ({id, name:id, description:'', shared, thumbnail:'',modifiedAt:1,duration:180,resolution:'1920 × 1080',fps:24,status:'In progress',members:[{userId:clients[0].id,role:'Owner'}]});
    initial.state.projects = [project('shared', true), project('private', false)];
    initial.state.timelines = [{id:'timeline',projectId:'shared',name:'Timeline',duration:180}];
    initial.state.tracks = [{id:'track',timelineId:'timeline',name:'Video',kind:'video',number:1,muted:false,solo:false,locked:false,hidden:false,gain:0,pan:0,height:60}];
    initial.state.operations = Array.from({length:100},(_,i)=>({id:`op${i}`,projectId:'shared',userId:clients[0].id,timestamp:i,targetId:'track',type:'TrackChanged',description:'Existing history',oldState:[],newState:[]}));
    assert.equal((await request(0, '/state', 'PUT', initial)).status, 200);
    const owner = (await request(0, '/state')).data;
    const observers = await Promise.all([1,2,3,4].map(async i => (await request(i, '/state')).data));
    assert.deepEqual(observers[0].state.projects.map((p: {id:string})=>p.id), ['shared']);
    const readers = await Promise.all([1,2,3,4].map(async i => {
      const abort = new AbortController(); streams.push(abort);
      const response = await fetch(`${url}/events?clientId=client${i}`, {headers:{cookie:clients[i].cookie},signal:abort.signal});
      const reader = response.body!.getReader();
      await reader.read(); // Initial change event.
      assert.equal((await request(i,'/presence','POST',{projectId:'shared',timelineId:'timeline',clientId:`client${i}`,active:false,cursor:null,playhead:0})).status,200);
      return reader;
    }));
    const nextPreview = async (reader: ReadableStreamDefaultReader<Uint8Array>, height: number) => {
      let buffer = '';
      while (true) {
        const {value, done} = await reader.read(); if (done) throw new Error('Event stream ended.');
        buffer += new TextDecoder().decode(value);
        const frames = buffer.split('\n\n'); buffer = frames.pop()!;
        for (const frame of frames) if (frame.startsWith('event: presence')) {
          const data = JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
          if (data.presence.some((p: any) => p.userId === clients[0].id && p.preview?.tracks?.[0]?.height === height)) return;
        }
      }
    };
    const started = performance.now();
    const receiving = readers.map(reader => nextPreview(reader, 95));
    assert.equal((await request(0,'/presence','POST',{projectId:'shared',timelineId:'timeline',clientId:'client0',active:true,cursor:{surface:'timeline',anchor:'track',x:2,y:.5},playhead:0,preview:{tracks:[{id:'track',height:95}]}})).status,200);
    await Promise.race([Promise.all(receiving),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Idle observers did not receive preview')),1500);timer.unref();})]);
    const previewMs = performance.now() - started;
    const unchanged = (await request(0,'/state')).data;
    assert.equal(unchanged.revision, owner.revision, 'Previews never write project state.');
    assert.equal(unchanged.state.tracks[0].height,60);
    assert.equal((await request(0,'/presence','POST',{projectId:'shared',timelineId:'timeline',preview:{tracks:[{id:'track',height:999}]}})).status,400);
    const next: PersistedState = {...owner.state,tracks:owner.state.tracks.map((t: any)=>({...t,height:95}))};
    const delta = stateDelta(owner.state,next);
    assert.deepEqual(Object.keys(delta),['tracks']);
    const saved = await request(0,'/state','PATCH',{revision:owner.revision,delta});
    assert.equal(saved.status,200);
    assert.equal(saved.data.state,undefined,'Acknowledgements must not resend history.');
    assert.deepEqual(applyStateDelta(next,saved.data.delta),(await request(0,'/state')).data.state);
    for(let i=1;i<5;i++) {
      const response = await request(i,`/state?since=${observers[i-1].revision}&delta=1`);
      assert.equal(response.data.state,undefined);
      const updated = applyStateDelta(observers[i-1].state,response.data.delta);
      assert.equal(updated.tracks[0].height,95);
      assert.equal(updated.operations,observers[i-1].state.operations,'Unchanged history keeps its identity.');
      assert.deepEqual(updated.projects.map(p=>p.id),['shared']);
    }
    assert.equal((await request(1,'/state','PATCH',{revision:owner.revision,delta})).status,409,'Stale revisions still conflict.');
    const current=(await request(1,'/state')).data;
    assert.equal((await request(1,'/state','PATCH',{revision:current.revision,delta:{currentUserId:clients[0].id}})).status,403);
    assert.equal((await request(1,'/state','PATCH',{revision:current.revision,delta:{tracks:{upsert:[next.tracks[0],next.tracks[0]],remove:[]}}})).status,400);
    assert.equal((await request(0,'/locks','POST',{projectId:'shared',targetId:'track',field:'*'})).status,200);
    assert.equal((await request(1,'/state','PATCH',{revision:current.revision,delta:{tracks:{upsert:[{...next.tracks[0],height:80}],remove:[]}}})).status,423);
    const ordered={...next,operations:[{...next.operations[0],id:'new'},...next.operations].reverse()};
    assert.deepEqual(applyStateDelta(next,stateDelta(next,ordered)),ordered,'Reorders and additions round-trip.');
    assert.equal(shareState(next,structuredClone(next)).operations,next.operations);
    console.log(JSON.stringify({observers:4,previewMs:Math.round(previewMs),fullStateBytes:JSON.stringify(owner.state).length,editBytes:JSON.stringify(delta).length}));
  } finally {
    streams.forEach(stream=>stream.abort()); await app.close(); await rm(dir,{recursive:true,force:true});
  }
});
