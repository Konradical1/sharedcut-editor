import type { Presence, PresenceCursor } from '../state/models.ts';

export function receivedPresence(people: Presence[], serverTime: number | undefined, now: number, previous?: Presence[]): Presence[] {
  // Alone in a project every reply is empty; keeping the old list spares every presence subscriber a re-render.
  if (!people.length && previous && !previous.length) return previous;
  // Measure packet age on the server's clock, then expire locally on the monotonic clock.
  return people.map(person => ({ ...person, receivedAt: now - Math.max(0, (serverTime ?? person.updatedAt) - person.updatedAt) }));
}

// Unknown/older clients have no content anchor, so their cursors stay hidden.
export function presenceCursor(value: unknown): PresenceCursor | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  if ((typeof c.surface !== 'string' || !/^(timeline|inspector|panel:[a-zA-Z0-9_-]+)$/.test(c.surface)) || typeof c.anchor !== 'string' || !c.anchor || c.anchor.length > 240 ||
      typeof c.x !== 'number' || !Number.isFinite(c.x) || c.x < 0 || c.x > (c.surface === 'timeline' ? 86400 * 7 : 1) ||
      typeof c.y !== 'number' || !Number.isFinite(c.y) || c.y < 0 || c.y > 1) return null;
  if (c.surface === 'inspector' && (typeof c.clipId !== 'string' || c.clipId.length > 160)) return null;
  for(const key of ['context','fallback','clipId'])if(c[key]!==undefined&&(typeof c[key]!=='string'||c[key].length>240))return null;
  return { ...(typeof c.context==='string'?{context:c.context}:{}), ...(typeof c.fallback==='string'?{fallback:c.fallback}:{}), surface: c.surface, anchor: c.anchor, x: c.x, y: c.y, ...(typeof c.clipId==='string' ? { clipId: c.clipId } : {}) };
}

export function cursorPosition(x: number, y: number, rect: { left: number; top: number; width: number; height: number }, timeSpan?: number) {
  return { x: (x - rect.left) / rect.width * (timeSpan ?? 1), y: (y - rect.top) / rect.height };
}

export interface PlayheadMotion { position: number; velocity: number; at: number; sampleAt: number; stamp: number; target: number; playing: boolean }
export function playheadMotion(person: Presence, now: number): PlayheadMotion {
  return { position: person.playhead, velocity: 0, at: now, sampleAt: now, stamp: person.updatedAt, target: person.playhead, playing: !!person.playing };
}
export function advancePlayhead(m: PlayheadMotion, person: Presence, now: number): number {
  const dt = Math.max(0, (now - m.at) / 1000);
  // Analytic critically damped spring: preserve velocity when packets arrive.
  // A moving reference tracks playback at 1 second/second, independent of frame rate.
  const speed = m.playing && now - m.sampleAt < 2000 ? 1 : 0;
  const target = m.target + (m.playing ? Math.min(2, Math.max(0, (m.at - m.sampleAt) / 1000)) : 0);
  const omega = 35, offset = m.position - target, velocity = m.velocity - speed;
  const c = velocity + omega * offset, decay = Math.exp(-omega * dt);
  m.position = target + speed * dt + (offset + c * dt) * decay;
  m.velocity = speed + (velocity - omega * c * dt) * decay;
  m.at = now;
  if (person.updatedAt !== m.stamp || person.playhead !== m.target || !!person.playing !== m.playing) {
    m.stamp = person.updatedAt; m.target = person.playhead; m.playing = !!person.playing; m.sampleAt = now;
  }
  if (!m.playing && Math.abs(m.position - m.target) < .0001 && Math.abs(m.velocity) < .001) { m.position = m.target; m.velocity = 0; }
  return Math.max(0, m.position);
}

export interface CursorMotion { x: number; y: number; vx: number; vy: number; targetX: number; targetY: number; at: number }
export function advanceCursor(m: CursorMotion | undefined, x: number, y: number, now: number): CursorMotion {
  if (!m) return { x, y, vx: 0, vy: 0, targetX: x, targetY: y, at: now };
  const dt = Math.max(0, (now - m.at) / 1000), omega = 35, decay = Math.exp(-omega * dt);
  // Integrate the previous target first: a packet changes the destination, never position or velocity.
  for (const [axis, velocity, target] of [['x', 'vx', 'targetX'], ['y', 'vy', 'targetY']] as const) {
    const offset = m[axis] - m[target], c = m[velocity] + omega * offset;
    m[axis] = m[target] + (offset + c * dt) * decay;
    m[velocity] = (m[velocity] - omega * c * dt) * decay;
    if (Math.abs(m[axis] - m[target]) < .01 && Math.abs(m[velocity]) < .1) { m[axis] = m[target]; m[velocity] = 0; }
  }
  m.targetX = x; m.targetY = y; m.at = now;
  return m;
}

// 20Hz is for a pointer in motion. Standing still, a heartbeat a second keeps the editor present and
// leaves the server free to move everyone's edits instead of re-answering an identical question.
export const PRESENCE_HEARTBEAT = 900;
// While playing the playhead changes every tick; followers extrapolate it (advancePlayhead), so 4 Hz is plenty.
export const PLAYING_PRESENCE_INTERVAL = 250;
export function presenceDue(signature: string, published: string, since: number, playing = false) {
  return since >= PRESENCE_HEARTBEAT || signature !== published && (!playing || since >= PLAYING_PRESENCE_INTERVAL);
}
