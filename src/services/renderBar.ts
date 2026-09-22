/** Premiere-style ruler bar: red beats yellow beats green wherever clips overlap. */
export type BarState = 'gray' | 'blue' | 'green' | 'yellow' | 'red';
export type BarClip = { start: number; end: number; state: BarState };
export type BarSegment = { start: number; end: number; state: BarState };

const rank: Record<BarState, number> = { green: 0, gray: 1, blue: 2, yellow: 3, red: 4 };

/** One segment per colour run, so the ruler paints a handful of elements rather than one per clip. */
export function barSegments(clips: BarClip[]): BarSegment[] {
  const edges = [...new Set(clips.flatMap(clip => [clip.start, clip.end]))].filter(Number.isFinite).sort((a, b) => a - b);
  const segments: BarSegment[] = [];
  // ponytail: O(clips × edges); fine for a few hundred clips, sweep with a heap if timelines grow.
  for (let i = 0; i + 1 < edges.length; i++) {
    const start = edges[i], end = edges[i + 1];
    if (end - start < 1e-9) continue;
    let state: BarState | null = null;
    for (const clip of clips) if (clip.start < end && clip.end > start && (!state || rank[clip.state] > rank[state])) state = clip.state;
    if (!state) continue;
    const last = segments[segments.length - 1];
    if (last && last.state === state && Math.abs(last.end - start) < 1e-9) last.end = end; else segments.push({ start, end, state });
  }
  return segments;
}
