import { backoffDelay } from './backoff.ts';
import { presenceDue } from './presence.ts';

/** With the live-update stream down, presence is polled; an idle tab slows from a quarter second to once per 2 s. */
const IDLE_POLL_BASE_MS = 250, IDLE_POLL_MAX_MS = 2000;
/** With anyone else in the project the slowdown stops here: their cursors and drag ghosts (shown for 2 s) need a fresh answer. */
const IDLE_POLL_WITH_OTHERS_MS = 500;
export const idlePollGap = (idlePolls: number, random?: () => number) => backoffDelay(idlePolls, IDLE_POLL_BASE_MS, IDLE_POLL_MAX_MS, 0.25, random);

type Tick = { signature: string; published: string; sinceMs: number; playing: boolean; paced: boolean; streamUp: boolean; othersPresent?: boolean };
/**
 * Decides, on each 50 ms tick, whether this tab posts its presence. With the stream up, or while a big drag is
 * paced, or when something changed, presenceDue alone decides. An idle tab with the stream down used to post every
 * 100 ms to learn what others were doing; it now waits a growing, jittered gap (never over half a second while others
 * are in the project), and any change starts that over.
 */
export function createPresencePacer(random?: () => number) {
  let idlePolls = 0, gapMs = idlePollGap(0, random);
  return {
    due(tick: Tick) {
      const idle = !tick.streamUp && !tick.paced && tick.signature === tick.published;
      const wanted = idle ? tick.sinceMs >= (tick.othersPresent ? Math.min(gapMs, IDLE_POLL_WITH_OTHERS_MS) : gapMs) : presenceDue(tick.signature, tick.published, tick.sinceMs, tick.playing);
      if (wanted) gapMs = idlePollGap(idle ? idlePolls++ : (idlePolls = 0), random);
      return wanted;
    },
  };
}
