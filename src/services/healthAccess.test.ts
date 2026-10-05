import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from './api.ts';
import { forgetHealthAccess, healthAvailable } from './healthAccess.ts';

/** An ask that answers with `outcome` each time and counts how often it was asked. */
function asker(outcome: () => Promise<unknown>) {
  const counter = { calls: 0 };
  return { counter, ask: () => { counter.calls++; return outcome(); } };
}
const refused = (status: number) => () => Promise.reject(new ApiError(status, { error: 'nope' }));

test('an owner sees the Health entry, and the answer is asked once per session', async () => {
  forgetHealthAccess();
  const { ask, counter } = asker(() => Promise.resolve({ people: [] }));
  assert.equal(await healthAvailable('alice', ask), true);
  assert.equal(await healthAvailable('alice', ask), true);
  assert.equal(counter.calls, 1);
});

test('a 404 hides the entry and is remembered, so non-owners cost one request', async () => {
  forgetHealthAccess();
  const { ask, counter } = asker(refused(404));
  assert.equal(await healthAvailable('bob', ask), false);
  assert.equal(await healthAvailable('bob', ask), false);
  assert.equal(counter.calls, 1);
});

test('a 403 is final as well', async () => {
  forgetHealthAccess();
  const { ask, counter } = asker(refused(403));
  assert.equal(await healthAvailable('bob', ask), false);
  assert.equal(await healthAvailable('bob', ask), false);
  assert.equal(counter.calls, 1);
});

test('a server error, a signed-out answer or an unreachable server hides the entry but is asked again next time', async () => {
  for (const outcome of [refused(500), refused(502), refused(401), () => Promise.reject(new TypeError('fetch failed'))]) {
    forgetHealthAccess();
    const { ask, counter } = asker(outcome);
    assert.equal(await healthAvailable('alice', ask), false);
    assert.equal(await healthAvailable('alice', ask), false);
    assert.equal(counter.calls, 2, 'not remembered: the owner would otherwise lose the entry until a reload');
  }
});

test('a recovered server shows the entry on the next ask', async () => {
  forgetHealthAccess();
  let up = false;
  const { ask } = asker(() => up ? Promise.resolve({}) : Promise.reject(new TypeError('fetch failed')));
  assert.equal(await healthAvailable('alice', ask), false);
  up = true;
  assert.equal(await healthAvailable('alice', ask), true);
});

test('two askers at once share one request', async () => {
  forgetHealthAccess();
  const { ask, counter } = asker(() => Promise.resolve({}));
  const answers = await Promise.all([healthAvailable('alice', ask), healthAvailable('alice', ask)]);
  assert.deepEqual(answers, [true, true]);
  assert.equal(counter.calls, 1);
});

test('another account on the same tab is asked on its own', async () => {
  forgetHealthAccess();
  const { ask, counter } = asker(() => Promise.resolve({}));
  await healthAvailable('alice', ask);
  await healthAvailable('bob', ask);
  assert.equal(counter.calls, 2);
});

test('an ask that throws before returning a promise is an answer of no', async () => {
  forgetHealthAccess();
  assert.equal(await healthAvailable('alice', () => { throw new Error('sync failure'); }), false);
});
