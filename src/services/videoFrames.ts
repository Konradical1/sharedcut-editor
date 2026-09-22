/** Explicitly decoded pictures. Encoded bytes remain in the automatic persistent footage cache. */
export function createVideoFrames(url: string, fps: number, changed: () => void, cacheEnabled = true) {
  const worker = new Worker(new URL('./videoDecodeWorker.ts', import.meta.url), { type: 'module' });
  const frames: VideoFrame[] = [];
  let target = 0, generation = 0, pending = 0, disposed = false, ended = false, error = '', frameBytes = 0;
  const start = (frame: VideoFrame) => frame.timestamp / 1e6;
  const end = (frame: VideoFrame) => start(frame) + (frame.duration ? frame.duration / 1e6 : 1 / fps);
  const clear = () => { for (const frame of frames) frame.close(); frames.length = 0; };
  const fill = () => {
    if (disposed || ended || error || !generation) return;
    // ponytail: up to 0.5 s / 24 pictures / 32 MiB in the compositor, plus the worker's small decode queue.
    // The decoder can refill faster than playback; no pause/play startup penalty at the memory ceiling.
    const capacity = frameBytes ? Math.max(2, Math.min(24, Math.ceil(fps / 2), Math.floor(32 * 1024 ** 2 / frameBytes))) : 1;
    const count = capacity - frames.length - pending;
    if (count <= 0 || frames.length && end(frames.at(-1)!) >= target + .5) return;
    pending += count; worker.postMessage({ type: 'read', generation, count });
  };
  worker.onmessage = event => {
    const message = event.data;
    if (disposed || message.generation !== generation) { message.frame?.close(); return; }
    if (message.type === 'frame') {
      pending = Math.max(0, pending - 1);
      const frame: VideoFrame = message.frame;
      try { frameBytes = frame.allocationSize(); } catch { frameBytes = frame.codedWidth * frame.codedHeight * 4; }
      if (end(frame) <= target + 1e-6) frame.close(); else frames.push(frame);
      fill(); changed();
    } else if (message.type === 'end') { pending = 0; ended = true; changed(); }
    else if (message.type === 'error') { pending = 0; error = message.error || 'Video decoding failed.'; changed(); }
  };
  worker.onerror = event => { error = event.message || 'Video decoder worker failed.'; changed(); };
  const frameAt=(time:number)=>frames.find(frame => start(frame) <= time + 1e-6 && end(frame) > time + 1e-6);
  worker.postMessage({ type: 'open', url: new URL(url, location.href).href, cacheEnabled });
  return {
    cacheEnabled,
    get failed() { return !!error; },
    get error() { return error; },
    get ahead() { return frames.length ? Math.max(0, end(frames.at(-1)!) - target) : 0; },
    update(time: number) {
      if (disposed || error) return;
      const rewind = time < target - 1e-6 && (!frames.length || time < start(frames[0]) - 1e-6);
      const jump = time > target + 1;
      target = time;
      if (!generation || rewind || jump) {
        clear(); generation++; pending = 1; ended = false;
        worker.postMessage({ type: 'seek', generation, time, count: 1 });
      }
      while (frames.length && end(frames[0]) <= target + 1e-6) frames.shift()!.close();
      fill();
    },
    frame(time: number) {
      // Select the actual presentation interval, not the nearest snapshot or a source-FPS estimate.
      return frameAt(time);
    },
    prepare(time: number, step = 1 / fps) {
      // Prepare the next displayed samples, not just adjacent source frames (e.g. 60 fps into 24 fps).
      return [...new Set([0,1,2].map(offset=>frameAt(time+offset*step)).filter((frame):frame is VideoFrame=>!!frame))];
    },
    dispose() { disposed = true; worker.terminate(); clear(); },
  };
}
