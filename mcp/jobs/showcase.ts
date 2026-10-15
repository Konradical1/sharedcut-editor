import { call, done, type JobDef } from './kit.ts';
import { frameAt, type ReplayPackage } from '../../src/services/showcaseReplay.ts';
export const jobs:Record<string,JobDef>={showcase:{
  doc:'{slug?, time?} read a published replay, contributors, chapters, and the recorded edit at replay seconds',
  async start(params){const slug=String(params.slug??'girls-soccer');if(!/^[a-z0-9-]+$/.test(slug))throw Error('Invalid replay slug');const replay=await call<ReplayPackage>(`/showcase/${slug}/replay.json`);const time=Math.max(0,Math.min(replay.duration,Number(params.time??0)));if(!Number.isFinite(time))throw Error('time must be finite');const frame=replay.frames[frameAt(replay,time)];return done(JSON.stringify({title:replay.title,duration:replay.duration,authors:replay.authors,chapters:replay.chapters,time,action:frame.action,author:replay.authors.find(a=>a.id===frame.author)?.name,clips:frame.clips.length,provenance:replay.provenance}));}
}};
export const topics={showcase:'job{kind:"showcase",params:{slug:"girls-soccer",time:20}} reads the curated replay at /demo. Cursor paths illustrate recorded edit targets; idle time is compressed. The final checkpoint corrects gaps in older history. Source projects remain private.'};
