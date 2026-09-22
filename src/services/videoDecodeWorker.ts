import { Input, MP4, CustomSource, VideoSampleSink, type VideoSample } from 'mediabunny';

// One worker per retained clip; the playback pool bounds their lifetime. Demuxing and decoding
// are independent of browser presentation callbacks, so a busy UI cannot create holes in the queue.
let input: Input | undefined, sink: Promise<VideoSampleSink> | undefined;
let iterator: AsyncGenerator<VideoSample, void, unknown> | undefined;
let generation = 0, from = 0, credit = 0, restart = false, busy = false;
const send = (data: unknown, transfer: Transferable[] = []) => postMessage(data, { transfer });
async function pump() {
  if (busy || !sink) return;
  busy = true;
  try {
    const samples = await sink;
    while (credit > 0) {
      if (restart) {
        await iterator?.return();
        iterator = samples.samples(from); restart = false;
      }
      const epoch = generation, next = await iterator!.next();
      if (epoch !== generation) { next.value?.close(); continue; }
      if (next.done) { credit = 0; send({ type: 'end', generation }); break; }
      const sample = next.value;
      try {
        const frame = sample.toVideoFrame();
        credit--; send({ type: 'frame', generation, frame }, [frame]);
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
    // Timeline caching owns lookahead. An open-ended network prefetch would read beyond
    // the saved clip and turn an unrelated cache miss into a decoder failure.
    const read = async (start: number, end: number) => {
      const response = await fetch(message.url, {
        credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
        headers: { Range: `bytes=${start}-${end - 1}`, ...(message.cacheEnabled === false ? {'X-Footage-Cache':'off'} : {}) },
      });
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
      if (response.status !== 206 || !range || +range[1] !== start || +range[2] !== end - 1) {
        await response.body?.cancel();
        throw new Error(`Preview byte range unavailable (${response.status}).`);
      }
      size = +range[3];
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== end - start) throw new Error('Incomplete preview byte range.');
      return bytes;
    };
    input = new Input({ formats: [MP4], source: new CustomSource({
      getSize: async () => { await read(0, 1); return size; }, read,
      maxCacheSize: 4 * 1024 ** 2, prefetchProfile: 'fileSystem',
      dispose: () => controller.abort(),
      handleUnhandledError: error => send({ type: 'error', generation, error: String(error) }),
    }) });
    sink = (async () => {
      const track = await input!.getPrimaryVideoTrack();
      if (!track || !await track.canDecode()) throw new Error('This browser cannot decode this preview with WebCodecs.');
      return new VideoSampleSink(track);
    })();
    // The first seek attaches its own handler; avoid an unhandled rejection before it arrives.
    void sink.catch(() => {});
  } else if (message.type === 'seek') {
    generation = message.generation; from = message.time; credit = message.count; restart = true;
    // Release a pending iterator immediately; its obsolete output is rejected by generation above.
    void iterator?.return(); void pump();
  } else if (message.type === 'read' && message.generation === generation) {
    credit += message.count; void pump();
  }
};
