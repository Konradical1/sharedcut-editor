import test from 'node:test';
import assert from 'node:assert/strict';
import { createPresencePacer, idlePollGap } from './syncPacing.ts';

const longest = () => 0, shortest = () => 0.999999;
const idle = { signature: 'same', published: 'same', playing: false, paced: false, streamUp: false, othersPresent: false };

/** One tab, nothing changing, polled every 50 ms for `seconds`: when does it post? */
function idlePosts(random: () => number, seconds = 60, flags: Partial<typeof idle> = {}) {
  const pacer = createPresencePacer(random), posts: number[] = [];
  let last = -Infinity;
  for (let t = 0; t <= seconds * 1000; t += 50) if (pacer.due({ ...idle, ...flags, sinceMs: t - last })) { posts.push(t); last = t; }
  return posts;
}

test('the wait between idle posts grows from a quarter second to two seconds and stays there', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(n => idlePollGap(n, longest)), [250, 500, 1000, 2000, 2000, 2000]);
  assert.ok(idlePollGap(3, shortest) >= 1500 && idlePollGap(3, shortest) <= 2000, 'jitter only shortens it');
});

test('an idle tab with the live-update stream down posts about once per 2 s, not 10 times a second', () => {
  const slow = idlePosts(longest), quick = idlePosts(shortest);
  assert.ok(slow.length >= 25 && slow.length <= 34, `${slow.length} posts in a minute`);
  assert.ok(quick.length <= 45, `${quick.length} posts in a minute with the most jitter`);
  const gaps = slow.slice(1).map((t, i) => t - slow[i]);
  assert.deepEqual(gaps.slice(0, 4), [250, 500, 1000, 2000], 'the backoff starts quick and slows');
  assert.ok(gaps.every(gap => gap <= 2000), 'never a gap longer than 2 s plus a tick once settled');
  assert.ok(slow.at(-1)! > 55_000, 'and it keeps posting, so others still see the tab');
});

test('with the stream down, an idle tab with collaborators present still posts at least every half second', () => {
  const posts = idlePosts(longest, 30, { othersPresent: true });
  const gaps = posts.slice(1).map((t, i) => t - posts[i]);
  assert.ok(gaps.length > 55 && gaps.every(gap => gap <= 500), `${gaps.length} gaps, longest ${Math.max(...gaps)} ms`);
  assert.deepEqual(gaps.slice(0, 3), [250, 500, 500], 'the quick start is kept, the slowdown stops at half a second');
  const alone = idlePosts(longest, 30, { othersPresent: false });
  assert.ok(alone.length < posts.length / 2, 'alone in the project it still backs off to 2 s');
});

test('someone joining an idle, backed-off tab speeds it up without waiting out the long gap', () => {
  const pacer = createPresencePacer(longest);
  for (let i = 0; i < 6; i++) pacer.due({ ...idle, sinceMs: 5000 });
  assert.equal(pacer.due({ ...idle, sinceMs: 499 }), false, 'alone: settled at 2 s');
  assert.equal(pacer.due({ ...idle, othersPresent: true, sinceMs: 500 }), true);
});

test('with the stream up, an idle tab posts only on the heartbeat, exactly as before', () => {
  const pacer = createPresencePacer(longest);
  assert.equal(pacer.due({ ...idle, streamUp: true, sinceMs: 100 }), false);
  assert.equal(pacer.due({ ...idle, streamUp: true, sinceMs: 899 }), false);
  assert.equal(pacer.due({ ...idle, streamUp: true, sinceMs: 900 }), true);
});

test('a change posts at once even with the stream down, and a running playhead at 4 Hz', () => {
  const pacer = createPresencePacer(longest);
  assert.equal(pacer.due({ ...idle, published: 'old', sinceMs: 50 }), true, 'a moved cursor does not wait for the idle gap');
  assert.equal(pacer.due({ ...idle, published: 'old', playing: true, sinceMs: 100 }), false);
  assert.equal(pacer.due({ ...idle, published: 'old', playing: true, sinceMs: 250 }), true);
});

test('a change starts the idle backoff over', () => {
  const pacer = createPresencePacer(longest);
  for (let i = 0; i < 6; i++) pacer.due({ ...idle, sinceMs: 5000 });
  assert.equal(pacer.due({ ...idle, sinceMs: 1999 }), false, 'settled at 2 s');
  assert.equal(pacer.due({ ...idle, published: 'old', sinceMs: 10 }), true);
  assert.equal(pacer.due({ ...idle, sinceMs: 249 }), false);
  assert.equal(pacer.due({ ...idle, sinceMs: 250 }), true, 'back to a quarter second');
});

test('a big drag being paced and a reopened stream are not slowed by the idle rule', () => {
  const pacer = createPresencePacer(longest);
  assert.equal(pacer.due({ ...idle, paced: true, playing: true, sinceMs: 100 }), false);
  assert.equal(pacer.due({ ...idle, paced: true, playing: true, published: 'old', sinceMs: 250 }), true);
  assert.equal(idlePosts(longest, 10, { streamUp: true }).length, 12, 'stream up: heartbeat posts only, one per 900 ms');
});
