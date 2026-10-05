// The shapes the browser's playback report, the server's Health summary and the Health page share.
// Numbers only: no clip, file or project names ever leave the browser in a report.

/** One browser's view of how playback is going, sent inside the presence heartbeat as `health`. */
export type PlaybackReport = {
  v: 1;
  /** Short build id of the client bundle. */
  build: string;
  /** Client clock, ms. The server stamps its own receive time and ignores this for ordering. */
  at: number;
  /** Length of the measurement window, ms. */
  windowMs: number;
  playing: boolean;
  targetFps: number;
  /** Distinct pictures per second shown over the window (0 while paused). */
  fps: number;
  /** Share of the window spent waiting for a picture, 0-100. */
  loadingPct: number;
  worstFreezeMs: number;
  /** Milliseconds of the window spent waiting on each kind of work. */
  waitMs: { color: number; decode: number; buffer: number; seek: number; other: number };
  /** Footage worker throughput while it was downloading, Mbps. */
  linkMbps: number | null;
  rttMs: number | null;
  /** navigator.connection.effectiveType. */
  netType: string | null;
  downlinkMbps: number | null;
  saveData: boolean;
  cores: number | null;
  memoryGB: number | null;
  /** Trimmed WebGL renderer string. */
  gpu: string;
  /** Short browser/OS label such as "Chrome 152 ChromeOS". */
  agent: string;
  /** Main-thread long-task time in the window, ms. */
  longTaskMs: number | null;
  quality: string;
  engine: string;
  /** Where the pictures come from: the live compositor, the 960 stream, the low stream or a server-rendered preview. */
  source: 'live' | 'stream' | 'low' | 'rendered';
  /** Playhead position in whole minutes, so stalls can be placed on the timeline. */
  playheadMin: number;
  /** Share of the timeline's footage saved on this computer, 0-100. */
  cachedPct: number | null;
  /** True for runs made by the test harness (shown separately, never counted as a person). */
  harness: boolean;
  /** True when the browser runs on the server's own computer. */
  onHost: boolean;
};

export type HealthLight = 'green' | 'amber' | 'red' | 'grey';

export type PersonHealth = {
  userId: string;
  name: string;
  clientId: string;
  projectId: string | null;
  online: boolean;
  lastSeenAt: number;
  light: HealthLight;
  /** Plain-language diagnosis, e.g. "Computer too slow: 4 of 30 pictures/s, 51% waiting on colour processing". */
  sentence: string;
  latest: PlaybackReport | null;
  /** One entry per minute, oldest first. */
  recent: { at: number; fps: number; loadingPct: number; worstFreezeMs: number; light: HealthLight }[];
  harness: boolean;
};

export type HostHealth = {
  at: number;
  freeGB: number;
  commitHeadroomGB: number | null;
  pagesPerSec: number | null;
  queued: number;
  running: number;
  previewsRunning: number;
  guardMode: 'off' | 'observe' | 'enforce';
  eventLoopLagMs: number | null;
  onBattery: boolean | null;
  gpuMemUsedGB: number | null;
  gpuTempC: number | null;
};

export type HealthSummary = { generatedAt: number; host: HostHealth; people: PersonHealth[] };
