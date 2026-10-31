import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { projectActivity } from './projectActivity.ts';

test('latest activity persists, expires at 24 hours, and is limited to accessible projects', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const activity = projectActivity(db); const now = Date.now();
    activity.record('film', 'alice', 'edited', now - 120_000);
    activity.record('private', 'alice', 'viewed', now);
    activity.record('old', 'alice', 'edited', now - 86_400_000);
    assert.deepEqual(activity.latest(new Set(['film', 'old']), now), { film: { userId: 'alice', kind: 'edited', timestamp: now - 120_000 } });
    activity.record('film', 'bob', 'viewed', now - 60_000);
    assert.equal(projectActivity(db).latest(new Set(['film']), now).film.userId, 'bob');
    activity.record('film', 'alice', 'edited', now);
    activity.record('film', 'alice', 'viewed', now + 1000, now - 5000);
    assert.equal(activity.latest(new Set(['film']), now + 1000).film.kind, 'edited', 'presence during the same visit must not erase a real edit');
    activity.record('film', 'alice', 'viewed', now + 40_000, now + 40_000);
    assert.equal(activity.latest(new Set(['film']), now + 40_000).film.kind, 'viewed', 'a new visit is viewing');
  } finally { db.close(); }
});
