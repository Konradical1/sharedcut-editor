import { BufferSource, Input, MP4, VideoSampleSink, type VideoSample } from 'mediabunny';
import { DEPTH_SEGMENT_RATE } from './depth.ts';

// Decodes depth preview segments (H.264, depth in full-range Y) into bare Y planes. One request at a time: a newer
// request stops the older one at its next frame. The last few segments' demuxers are kept (two clips on screen take
// turns), so a request inside one seeks (to the GOP before `from`) without parsing the file again.
const OPEN = 4;
let generation = 0;
const open = new Map<string, { input: Input; sink: Promise<VideoSampleSink> }>();

async function luma(sample: VideoSample) {
  const frame = sample.toVideoFrame();
  try {
    const { width, height } = frame.visibleRect!, out = new Uint8Array(width * height);
    if (frame.format && /^(I4|NV12)/.test(frame.format)) {
      const buffer = new Uint8Array(frame.allocationSize()), [{ offset, stride }] = await frame.copyTo(buffer);
      for (let y = 0; y < height; y++) out.set(buffer.subarray(offset + y * stride, offset + y * stride + width), y * width);
    } else {
      // A GPU frame has no CPU planes; full-range gray converts to R = G = B = Y.
      const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true })!;
      context.drawImage(frame, 0, 0);
      const rgba = context.getImageData(0, 0, width, height).data;
      for (let i = 0; i < out.length; i++) out[i] = rgba[i * 4];
    }
    return { data: out, width, height };
  } finally { frame.close(); }
}

onmessage = async ({ data }: MessageEvent<{ id: number; segment: string; buffer?: ArrayBuffer; from: number; count: number }>) => {
  const { id, from, count } = data, epoch = ++generation;
  try {
    let entry = open.get(data.segment);
    if (entry) open.delete(data.segment);
    else {
      if (!data.buffer) throw new Error('Depth segment bytes missing.');
      const input = new Input({ formats: [MP4], source: new BufferSource(data.buffer) });
      entry = { input, sink: (async () => {
        const track = await input.getPrimaryVideoTrack();
        if (!track || !await track.canDecode()) throw new Error('This browser cannot decode depth previews with WebCodecs.');
        return new VideoSampleSink(track);
      })() };
    }
    open.set(data.segment, entry);
    while (open.size > OPEN) { const [oldest, value] = open.entries().next().value!; open.delete(oldest); value.input.dispose(); }
    const sink = await entry.sink;
    // Frame i sits at i / rate; a quarter frame in picks frame `from` without rounding doubt.
    for await (const sample of sink.samples((from + .25) / DEPTH_SEGMENT_RATE)) {
      try {
        if (epoch !== generation) return;
        const index = Math.round(sample.timestamp * DEPTH_SEGMENT_RATE);
        if (index >= from + count) break;
        if (index < from) continue;
        const plane = await luma(sample);
        postMessage({ type: 'frame', id, index, ...plane }, { transfer: [plane.data.buffer] });
      } finally { sample.close(); }
    }
    if (epoch === generation) postMessage({ type: 'done', id });
  } catch (error) {
    if (epoch !== generation) return; // A stopped request's error says nothing about the newer one.
    open.get(data.segment)?.input.dispose(); open.delete(data.segment);
    postMessage({ type: 'error', id, error: error instanceof Error ? error.message : String(error) });
  }
};
