/**
 * Paused-scrub pictures from the 480 px stream (stream-low-v2, the asset's 1/4). Its GOP is half a second, so a seek
 * decodes from the keyframe before the target; the worker hands over that whole GOP (a GOP seek), which makes every
 * later ask inside it free, and carries on into the next one when the scrub moves forward. Pictures are kept, so
 * scrubbing back over a stretch never decodes it twice. KEEP holds a 60 fps GOP twice over.
 */
const KEEP = 64, AHEAD = 3, NEAREST = 1;

export function createScrubFrames(url: string, fps: number, changed: (frame?: VideoFrame) => void, cacheEnabled = true) {
  const worker = new Worker(new URL('./videoDecodeWorker.ts', import.meta.url), { type: 'module' });
  const frames: VideoFrame[] = [];
  let generation = 0, wanted = NaN, failed = false, disposed = false;
  const start = (frame: VideoFrame) => frame.timestamp / 1e6;
  const end = (frame: VideoFrame) => start(frame) + (frame.duration ? frame.duration / 1e6 : 1 / fps);
  worker.onmessage = event => {
    const message = event.data;
    if (disposed) { message.frame?.close(); return; }
    if (message.type === 'frame') {
      // A superseded seek still decoded a real picture at its own timestamp; keep it.
      const frame: VideoFrame = message.frame;
      if (frames.some(held => held.timestamp === frame.timestamp)) { frame.close(); return; }
      frames.push(frame);
      if (frames.length > KEEP) frames.shift()!.close();
      changed(frame);
    } else if (message.type === 'error') { failed = true; changed(); }
  };
  worker.onerror = () => { failed = true; changed(); };
  worker.postMessage({ type: 'open', url: new URL(url, location.href).href, cacheEnabled });
  return {
    url,
    /** The exact picture when held, else the nearest held one within a second; always asks for the exact one. */
    frame(time: number) {
      if (disposed || failed) return undefined;
      const exact = frames.find(frame => start(frame) <= time + 1e-6 && end(frame) > time + 1e-6);
      if (exact) return exact;
      const index = Math.floor(time * fps + 1e-6);
      // One request per frame index; the worker abandons whatever a newer seek supersedes.
      if (index !== wanted) { wanted = index; worker.postMessage({ type: 'seek', generation: ++generation, time, count: AHEAD, gop: true }); }
      let nearest: VideoFrame | undefined;
      for (const frame of frames) if (Math.abs(start(frame) - time) <= NEAREST && (!nearest || Math.abs(start(frame) - time) < Math.abs(start(nearest) - time))) nearest = frame;
      return nearest;
    },
    dispose() { disposed = true; worker.terminate(); for (const frame of frames) frame.close(); frames.length = 0; },
  };
}
