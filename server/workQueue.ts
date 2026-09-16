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
