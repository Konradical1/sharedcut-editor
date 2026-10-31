import test from 'node:test';
import assert from 'node:assert/strict';
import { projectActivityLabel } from './library.ts';
test('project labels show the person, action, minutes and hours only during the past day', () => {
  const now = Date.now(), users = [{ id: 'alice', name: 'Alice Editor' }];
  const label = (age: number, kind: 'edited' | 'viewed' = 'edited') => projectActivityLabel({ userId: 'alice', kind, timestamp: now - age }, users, now);
  assert.equal(label(32 * 60_000), 'Alice Editor edited this 32 minutes ago');
  assert.equal(label(3600_000), 'Alice Editor edited this 1 hour ago');
  assert.equal(label(2 * 3600_000, 'viewed'), 'Alice Editor viewed this 2 hours ago');
  assert.equal(label(0), 'Alice Editor edited this just now');
  assert.equal(label(86_400_000), ''); assert.equal(label(-1), '');
});
