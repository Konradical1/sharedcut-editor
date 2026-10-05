/** The displayed pictures prepare() always names (the one on screen and the next two); a deeper look-ahead is opt-in. */
export const NEAR_PICTURES = 3;
/** A graded layer's colour copy takes 20-100 ms and up to 300 ms on a slow computer: copy this far ahead of the clock, within a byte budget. */
const AHEAD_SECONDS = .25, AHEAD_BYTES = 16 * 1024 ** 2, AHEAD_MAX = 10;

/** How many displayed pictures (one every `step` source seconds) prepare() names when asked to look deep. Never fewer than NEAR_PICTURES. */
export function aheadCount(step: number, frameBytes: number): number {
  const byTime = Math.ceil(AHEAD_SECONDS / Math.max(step, 1e-3) - 1e-9), byBytes = frameBytes > 0 ? Math.floor(AHEAD_BYTES / frameBytes) : NEAR_PICTURES;
  return Math.max(NEAR_PICTURES, Math.min(AHEAD_MAX, byTime, byBytes));
}

/** Is the source picture [start, end) one a clock stepping from `target` by `step` will show? Frames the clock steps over are never drawn. */
export function isShownPicture(start: number, end: number, target: number, step: number): boolean {
  // Timestamps are whole microseconds, so a picture that starts on a clock step can read a hair late: allow 10 µs.
  const index = Math.max(0, Math.ceil((start - target - 1e-5) / Math.max(step, 1e-6)));
  return target + index * step < end - 1e-6;
}

/**
 * Explicitly decoded pictures. Encoded bytes remain in the automatic persistent footage cache.
 * `arrived` is called with a picture the clock will show within AHEAD_SECONDS as it lands, so its colour copy starts at once.
 */
export function createVideoFrames(url: string, fps: number, changed: () => void, cacheEnabled = true, arrived?: (frame: VideoFrame) => void) {
  const worker = new Worker(new URL('./videoDecodeWorker.ts', import.meta.url), { type: 'module' });
  const frames: VideoFrame[] = [];
  let target = 0, generation = 0, pending = 0, disposed = false, ended = false, error = '', frameBytes = 0, step = 1 / fps;
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
      if (end(frame) <= target + 1e-6) frame.close();
      else { frames.push(frame); if (arrived && start(frame) < target + AHEAD_SECONDS && isShownPicture(start(frame), end(frame), target, step)) arrived(frame); }
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
    /** The next displayed pictures, nearest first; `deep` names the whole look-ahead window rather than the next three. */
    prepare(time: number, displayStep = 1 / fps, deep = false) {
      // Prepare the next displayed samples, not just adjacent source frames (e.g. 60 fps into 24 fps).
      step = displayStep;
      const count = deep ? aheadCount(displayStep, frameBytes) : NEAR_PICTURES;
      return [...new Set(Array.from({ length: count }, (_, offset) => frameAt(time + offset * displayStep)).filter((frame): frame is VideoFrame => !!frame))];
    },
    dispose() { disposed = true; worker.terminate(); clear(); },
  };
}
