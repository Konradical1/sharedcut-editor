import { Input, MP4, CustomSource, EncodedPacketSink, VideoSampleSink, type VideoSample } from 'mediabunny';

// One worker per retained clip; the playback pool bounds their lifetime. Demuxing and decoding
// are independent of browser presentation callbacks, so a busy UI cannot create holes in the queue.
let input: Input | undefined, sink: Promise<{ samples: VideoSampleSink; packets: EncodedPacketSink }> | undefined;
let iterator: AsyncGenerator<VideoSample, void, unknown> | undefined;
let generation = 0, from = 0, credit = 0, restart = false, busy = false;
/**
 * GOP seeks (paused scrubbing): a long-GOP seek decodes from the keyframe before `from` anyway, so every picture from
 * that keyframe to the next one is handed over, not only `credit` from `from` on. `runKey`/`runEnd` bound the GOP being
 * decoded, `shown` is where its pictures have reached; a later seek inside the same GOP and ahead of that carries on.
 */
let gop = false, runKey = NaN, runEnd = -Infinity, shown = -Infinity;
const send = (data: unknown, transfer: Transferable[] = []) => postMessage(data, { transfer });
/** Bytes are fetched in whole blocks of the footage worker's chunk size (public/footage-worker.js CHUNK); the latest few are kept. */
const BLOCK = 1 << 20, KEEP_BLOCKS = 2;
async function pump() {
  if (busy || !sink) return;
  busy = true;
  try {
    const { samples, packets } = await sink;
    while (credit > 0 || gop && shown < runEnd - 1e-4) {
      if (restart) {
        restart = false;
        let start = from;
        if (gop) {
          const key = await packets.getKeyPacket(from, { metadataOnly: true }) ?? await packets.getFirstPacket({ metadataOnly: true });
          const keyTime = key?.timestamp ?? 0, nextKey = key && (await packets.getNextKeyPacket(key, { metadataOnly: true }))?.timestamp;
          // Carry on when the target is ahead in the GOP being decoded, or in the next one right where decoding stopped:
          // dragging forward then costs one decoder for the whole drag instead of one per GOP.
          const carryOn = !!iterator && (keyTime === runKey && shown <= from + 1e-6 || keyTime === runEnd && shown >= runEnd - 1e-3);
          runKey = keyTime; runEnd = nextKey ?? Infinity;
          if (carryOn) continue;
          start = keyTime;
        } else runEnd = -Infinity;
        await iterator?.return();
        iterator = samples.samples(start); shown = -Infinity;
      }
      const epoch = generation, next = await iterator!.next();
      // A superseded playback seek's picture is dropped; a superseded scrub picture is still a real frame, so it is kept.
      if (epoch !== generation && !gop) { next.value?.close(); continue; }
      if (next.done) { credit = 0; runEnd = -Infinity; send({ type: 'end', generation }); break; }
      const sample = next.value;
      try {
        const frame = sample.toVideoFrame();
        shown = sample.timestamp + sample.duration;
        if (epoch === generation && (!gop || sample.timestamp + sample.duration > from + 1e-6)) credit--;
        send({ type: 'frame', generation, frame }, [frame]);
      } finally { sample.close(); }
    }
  } catch (error) {
    credit = 0;
    send({ type: 'error', generation, error: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; }
}
onmessage = event => {
  const message = event.data;
  if (message.type === 'open') {
    const controller = new AbortController();
    let size = 0;
    /** One aligned block, cut short at the end of the file. */
    const fetchBlock = async (index: number) => {
      const start = index * BLOCK, end = start + BLOCK;
      const response = await fetch(message.url, {
        credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        headers: { Range: `bytes=${start}-${end - 1}`, ...(message.cacheEnabled === false ? {'X-Footage-Cache':'off'} : {}) },
      });
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
      const last = range ? Math.min(end, +range[3]) - 1 : -1;
      if (response.status !== 206 || !range || +range[1] !== start || +range[2] !== last) {
        await response.body?.cancel();
        throw new Error(`Preview byte range unavailable (${response.status}).`);
      }
      size = +range[3];
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== last + 1 - start) throw new Error('Incomplete preview byte range.');
      return bytes;
    };
    // The decoder reads ~64 KiB at a time, and each read is a round trip through the footage worker or the network:
    // 50-400 ms apiece in Safari, ten of them before a cut's first picture. Whole aligned blocks are fetched instead and
    // sliced here. A block is exactly the footage worker's chunk, so no byte is read that a small read would not have
    // pulled into the cache anyway (timeline caching still owns lookahead).
    const blocks = new Map<number, Promise<Uint8Array>>();
    const block = (index: number) => {
      const job = blocks.get(index) ?? fetchBlock(index);
      blocks.delete(index); blocks.set(index, job);
      job.catch(() => { if (blocks.get(index) === job) blocks.delete(index); });
      for (const oldest of blocks.keys()) { if (blocks.size <= KEEP_BLOCKS) break; blocks.delete(oldest); }
      return job;
    };
    const read = async (start: number, end: number) => {
      const first = Math.floor(start / BLOCK), parts = await Promise.all(Array.from({ length: Math.floor((end - 1) / BLOCK) - first + 1 }, (_, i) => block(first + i)));
      const bytes = new Uint8Array(end - start);
      let at = 0;
      parts.forEach((part, i) => { const piece = part.subarray(i ? 0 : start - first * BLOCK, Math.min(part.length, end - (first + i) * BLOCK)); bytes.set(piece, at); at += piece.length; });
      if (at !== bytes.length) throw new Error('Incomplete preview byte range.');
      return bytes;
    };
    input = new Input({ formats: [MP4], source: new CustomSource({
      getSize: async () => { await block(0); return size; }, read,
      maxCacheSize: 4 * 1024 ** 2, prefetchProfile: 'fileSystem',
      dispose: () => controller.abort(),
      handleUnhandledError: error => send({ type: 'error', generation, error: String(error) }),
    }) });
    sink = (async () => {
      const track = await input!.getPrimaryVideoTrack();
      if (!track || !await track.canDecode()) throw new Error('This browser cannot decode this preview with WebCodecs.');
      return { samples: new VideoSampleSink(track), packets: new EncodedPacketSink(track) };
    })();
    // The first seek attaches its own handler; avoid an unhandled rejection before it arrives.
    void sink.catch(() => {});
  } else if (message.type === 'seek') {
    generation = message.generation; from = message.time; credit = message.count; restart = true; gop = Boolean(message.gop);
    // Release a pending iterator immediately; its obsolete output is rejected by generation above. A GOP seek may carry
    // on with it instead, so pump decides.
    if (!gop) void iterator?.return();
    void pump();
  } else if (message.type === 'read' && message.generation === generation) {
    credit += message.count; void pump();
  }
};
