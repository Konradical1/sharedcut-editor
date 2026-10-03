// One export at a time, `limit` media jobs alongside it; new media still waits for exports.
// A limit of 1 is the original strictly-serial behaviour and stays the default.
export function workQueue(limit = 1) {
  let renders = Promise.resolve();
  const waiting: (() => Promise<void>)[] = [], running = new Set<Promise<void>>();
  const pump = () => {
    while (running.size < limit && waiting.length) {
      const work = waiting.shift()!;
      const job: Promise<void> = (async () => {
        // Re-read `renders` until it stops moving: an export queued while we waited also goes first.
        let pending: Promise<void>;
        do { pending = renders; await pending; } while (pending !== renders);
        await work();
      })().catch(error => console.error('Media worker:', error)).finally(() => { running.delete(job); pump(); });
      running.add(job);
    }
  };
  return {
    add(work: () => Promise<void>, render = false) {
      if (render) renders = renders.then(work).catch(error => console.error('Render worker:', error));
      else { waiting.push(work); pump(); }
    },
    async drain() { while (running.size || waiting.length) await Promise.all([...running, renders]); await renders; },
  };
}

// At most `limit` jobs at once; the rest wait in order. A finishing job hands its slot straight to the next.
// An aborted `signal` drops a job from the wait (rejecting), so a cancelled job never sits on a slot it waits for.
export function limiter(limit: number) {
  let active = 0; const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (active < limit) active++;
    else await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new Error('Cancelled.')); return; }
      const go = () => { signal?.removeEventListener('abort', stop); resolve(); };
      const stop = () => { waiting.splice(waiting.indexOf(go), 1); reject(new Error('Cancelled.')); };
      waiting.push(go); signal?.addEventListener('abort', stop, { once: true });
    });
    try { return await work(); } finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}
// Smart Mask, motion tracking, optical flow and Stabilize each saturate the GPU or every core; across
// types only this many run at once. Exports and media preparation stay on their own queue, so none waits on the other.
export const heavyJob = limiter(Math.max(1, Math.floor(Number(process.env.FRAME_LINE_HEAVY_JOBS)) || 2));
// One job on the GPU at a time: depth analysis, Smart Mask tracking and caption transcription each want most of
// the Dell's 8 GB laptop GPU, which the desktop already holds 3 GB of. Always taken first, as
// gpuJob(() => heavyJob(...)): a job waiting for the GPU then holds no heavy slot, so flow, Stabilize and motion
// tracking keep running behind a long depth run. Nothing takes the GPU while holding a heavy slot, so no deadlock.
export const gpuJob = limiter(1);
