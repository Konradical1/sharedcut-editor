import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceCursor, advancePlayhead, playheadMotion, cursorPosition, presenceCursor, presenceDue, receivedPresence, PRESENCE_HEARTBEAT } from './presence.ts';
import type { Presence } from '../state/models.ts';
import { collaborationService } from './index.ts';

test('clock ticks preserve unchanged lock collections and still release expired leases', () => {
  const locks = [{ id: 'lease', expiresAt: 100 }] as Parameters<typeof collaborationService.expireLocks>[0];
  assert.equal(collaborationService.expireLocks(locks, 99), locks);
  assert.deepEqual(collaborationService.expireLocks(locks, 100), []);
  const empty: typeof locks = [];
  assert.equal(collaborationService.expireLocks(empty, 100), empty);
});
const person = (playhead = 0, updatedAt = 0, playing = false): Presence => ({ userId: 'remote', projectId: 'project', timelineId: 'timeline', cursor: null, playhead, updatedAt, playing, activity: 'edit', online: true });

test('presence age ignores computer clock offsets and preserves duplicate sample timestamps', () => {
  for (const serverTime of [10_000, 9_000_000_000_000]) {
    const remote = person(7, serverTime - 40, true);
    const [first] = receivedPresence([remote], serverTime, 100);
    assert.equal(first.receivedAt, 60);
    const [duplicate] = receivedPresence([remote], serverTime + 1000, 1100);
    assert.equal(duplicate.receivedAt, first.receivedAt, 'Repeated stale samples do not renew the cursor lifetime.');
    assert.equal(duplicate.updatedAt, remote.updatedAt, 'Playback prediction still recognizes duplicate packets.');
    const [stale] = receivedPresence([remote], serverTime + 9000, 9100);
    assert.ok(9100 - stale.receivedAt! > 8000);
  }
  assert.equal(receivedPresence([person()], undefined, 100)[0].receivedAt, 100, 'Older servers remain compatible.');
});

test('cursor time and track fraction survive zoom, scroll, density and interface scale', () => {
  const a = cursorPosition(460, 225, { left: 100, top: 200, width: 1080, height: 50 }, 180);
  const b = cursorPosition(550, 315, { left: -350, top: 300, width: 2700, height: 30 }, 180);
  assert.deepEqual(a, { x: 60, y: .5 });
  assert.deepEqual(b, a);
  const cursor = { surface: 'timeline', anchor: 'track-1', ...a };
  assert.deepEqual(presenceCursor(cursor), cursor);
  assert.equal(presenceCursor({ x: 50, y: 50 }), null);
  assert.equal(presenceCursor(null), null);
  for (const bad of [{...cursor,x:Infinity}, {...cursor,x:-1}, {...cursor,y:1.1}, {...cursor,surface:'viewer'}, {...cursor,anchor:''}]) assert.equal(presenceCursor(bad), null);
  assert.equal(presenceCursor({...cursor,surface:'inspector',x:.5}), null);
  assert.deepEqual(presenceCursor({surface:'inspector',anchor:'property-x',clipId:'clip',x:.5,y:.5}), {surface:'inspector',anchor:'property-x',clipId:'clip',x:.5,y:.5});
});

test('remote easing keeps position and velocity continuous, is frame-rate independent and settles exactly', () => {
  const target = person(20, 1);
  const a = playheadMotion(person(), 0), b = playheadMotion(person(), 0);
  advancePlayhead(a, target, 0); advancePlayhead(b, target, 0);
  for (let t = 10; t <= 100; t += 10) advancePlayhead(a, target, t);
  advancePlayhead(b, target, 100);
  assert.ok(Math.abs(a.position - b.position) < 1e-10);
  assert.ok(Math.abs(a.velocity - b.velocity) < 1e-10);
  const before = {...a};
  advancePlayhead(a, person(3, 2), 100);
  assert.equal(a.position, before.position); assert.equal(a.velocity, before.velocity);
  for (let t = 110; t <= 1000; t += 10) advancePlayhead(a, person(3, 2), t);
  assert.equal(a.position, 3); assert.equal(a.velocity, 0);
});

test('uneven packets and duplicate responses keep playback continuous without trusting remote clocks', () => {
  let remote = person(10, 9000000, true);
  const motion = playheadMotion(remote, 0);
  const arrivals = new Set([53, 117, 162, 231, 290, 347, 421, 482, 556, 610, 684, 750, 811, 874, 942]);
  let previous = motion.position;
  for (let t = 1; t <= 1200; t++) {
    if (arrivals.has(t)) remote = person(10+t/1000, 9000000+t, true);
    const value = advancePlayhead(motion, remote, t);
    assert.ok(value >= previous - 1e-10);
    if (t > 300) assert.ok(Math.abs(motion.velocity - 1) < .01);
    previous = value;
  }
  assert.ok(Math.abs(motion.position - 11.2) < .001);
  for (let t = 1210; t <= 5000; t += 10) advancePlayhead(motion, remote, t);
  assert.ok(Math.abs(motion.position - (remote.playhead + 2)) < .001, 'Packet loss stops prediction after two seconds.');
});

test('cursor eases between packets, preserves velocity on reversals, and settles at the exact point', () => {
  const a = advanceCursor(undefined, 10, 20, 0), b = advanceCursor(undefined, 10, 20, 0);
  advanceCursor(a, 310, 170, 0); advanceCursor(b, 310, 170, 0);
  let previous = a.x;
  for (let t = 10; t <= 100; t += 10) {
    advanceCursor(a, 310, 170, t);
    assert.ok(a.x > previous && a.x < 310, 'Every rendered frame moves between network samples.');
    previous = a.x;
  }
  advanceCursor(b, 310, 170, 100);
  for (const key of ['x', 'y', 'vx', 'vy'] as const) assert.ok(Math.abs(a[key]-b[key]) < 1e-9, key);
  const before = {...a};
  advanceCursor(a, 5, 15, 100);
  for (const key of ['x', 'y', 'vx', 'vy'] as const) assert.equal(a[key], before[key], 'Retargeting must not snap or restart velocity.');
  for (let t = 110; t <= 1000; t += 10) advanceCursor(a, 5, 15, t);
  assert.equal(a.x, 5); assert.equal(a.y, 15); assert.equal(a.vx, 0); assert.equal(a.vy, 0);
});

test('panel cursors retain content context and keyframe fallback, rejecting malformed packets',()=>{
 const c={surface:'panel:media-panel',anchor:'media-123',clipId:'clip',context:'Media',fallback:'track-label-1',x:.3,y:.7};
 assert.deepEqual(presenceCursor(c),c);
 assert.equal(presenceCursor({...c,context:42}),null);
 assert.equal(presenceCursor({...c,surface:'panel:bad"selector'}),null);
});

test('presence publishes every change at once and idles down to a heartbeat', () => {
  const moving = (x: number) => JSON.stringify([true, 'p', 't', { x, y: 4 }, 0, null, 'edit', false, false]);
  // A pointer in motion must never be held back, however fast the frames arrive.
  assert.equal(presenceDue(moving(2), moving(1), 0), true);
  assert.equal(presenceDue(moving(3), moving(2), 5), true);
  // A running playhead is a change too, even with the pointer parked.
  const parked = (playhead: number) => JSON.stringify([true, 'p', 't', null, playhead, null, 'edit', false, true]);
  assert.equal(presenceDue(parked(1.05), parked(1), 20), true);
  // Standing completely still costs one request a second instead of twenty.
  assert.equal(presenceDue(parked(1), parked(1), 50), false);
  assert.equal(presenceDue(parked(1), parked(1), PRESENCE_HEARTBEAT - 1), false);
  assert.equal(presenceDue(parked(1), parked(1), PRESENCE_HEARTBEAT), true, 'The server drops a client it has not heard from.');
});
