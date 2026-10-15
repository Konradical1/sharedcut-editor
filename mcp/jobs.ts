// The job tool: server-side work (uploads, analysis, exports…) that outlives one store action. Each feature keeps
// its jobs in mcp/jobs/<feature>.ts; this file only registers them and runs the wait/poll loop.
import { isPoller, sleep, type Content, type JobDef, type Poller, type Step } from './jobs/kit.ts';
import * as media from './jobs/media.ts';
import * as captions from './jobs/captions.ts';
import * as masks from './jobs/masks.ts';
import * as depth from './jobs/depth.ts';
import * as motion from './jobs/motion.ts';
import * as tracker from './jobs/tracker.ts';
import * as color from './jobs/color.ts';
import * as exporting from './jobs/export.ts';
import * as assets from './jobs/assets.ts';
import * as projects from './jobs/projects.ts';
import * as visual from './jobs/visual.ts';
import * as showcase from './jobs/showcase.ts';

const MODULES = [media, captions, masks, depth, motion, tracker, color, exporting, assets, projects, visual, showcase];
export const JOBS: Record<string, JobDef> = Object.assign({}, ...MODULES.map(m => m.jobs));
export const JOB_TOPICS: Record<string, string> = Object.assign({}, ...MODULES.map(m => m.topics ?? {}));
export const JOB_KINDS = Object.keys(JOBS);

type Running = { kind: string; poller: Poller; last?: Step; finished?: Step | { error: string } };
const running = new Map<string, Running>();
let next = 1;
const MAX_WAIT = 240;

function output(step: Step, suffix = ''): string | Content[] {
  const text = step.text + suffix;
  return step.content?.length ? [{ type: 'text', text }, ...step.content] : text;
}
async function waitFor(id: string, wait = 45): Promise<string | Content[]> {
  const job = running.get(id);
  if (!job) throw new Error(`No job ${id}. job{kind:"status"} lists them.`);
  if (job.finished) { if ('error' in job.finished) throw new Error(job.finished.error); return output(job.finished); }
  const deadline = Date.now() + Math.max(0, Math.min(MAX_WAIT, wait)) * 1000;
  for (;;) {
    let step: Step;
    try { step = await job.poller.poll(); }
    catch (error) { job.finished = { error: error instanceof Error ? error.message : String(error) }; throw error; }
    job.last = step;
    if (step.done) { job.finished = step; return output(step); }
    if (Date.now() >= deadline) return output(step, `\n… still running (${job.poller.label}). Poll: job{kind:"status", id:"${id}"}`);
    await sleep(Math.min(2000, Math.max(250, deadline - Date.now())));
  }
}

export async function runJob(kind: string, params: Record<string, any>, wait?: number): Promise<string | Content[]> {
  if (kind === 'cancel') {
    const job = running.get(String(params.id ?? ''));
    if (!job) throw new Error('params.id must name a running job.');
    if (job.finished) return `${job.kind} already finished.`;
    if (!job.poller.cancel) throw new Error(`A ${job.kind} job cannot be cancelled.`);
    await job.poller.cancel(); job.finished = { done: true, text: 'Cancelled.' };
    return `Cancelled ${job.kind}.`;
  }
  const def = JOBS[kind];
  if (!def) throw new Error(`No job kind "${kind}". help{topic:"jobs"} lists them.`);
  const started = await def.start(params ?? {});
  if (!isPoller(started)) return output(started);
  const id = `j${next++}`;
  running.set(id, { kind, poller: started });
  // Keep the last 50 jobs for status calls.
  if (running.size > 50) running.delete(running.keys().next().value!);
  return waitFor(id, wait);
}

export async function jobStatus(id: string, wait?: number): Promise<string | Content[]> {
  if (id) return waitFor(id, wait);
  if (!running.size) return 'No jobs this session.';
  return [...running].map(([key, job]) => `${key} ${job.kind}: ${job.finished ? ('error' in job.finished ? `failed: ${job.finished.error}` : 'done') : job.last?.text.split('\n')[0] ?? job.poller.label}`).join('\n');
}
