import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeState } from './merge.ts';

test('unchanged server polls retain local collection identities for playback subscribers', () => {
  const local = { clips: [{ id: 'shot', start: 0 }], media: [{ id: 'source', proxyUrl: '/proxy.mp4' }] };
  const merged = mergeState(structuredClone(local), local, structuredClone(local));
  assert.equal(merged.value, local);
  assert.equal(merged.value.clips, local.clips);
  assert.deepEqual(merged.conflicts, []);
});

test('three-way collaboration merge preserves independent edits, additions, and detects lost updates', () => {
  const base = { clips: [{ id: 'a', x: 1, y: 2 }], comments: [] as { id: string }[] };
  const local = { clips: [{ id: 'a', x: 3, y: 2 }], comments: [{ id: 'mine' }] };
  const remote = { clips: [{ id: 'a', x: 1, y: 4 }], comments: [{ id: 'theirs' }] };
  const result = mergeState(base, local, remote);
  assert.deepEqual(result.value.clips, [{ id: 'a', x: 3, y: 4 }]);
  assert.deepEqual(result.value.comments.map(x => x.id), ['theirs', 'mine']);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(mergeState(base, local, { ...remote, clips: [{ id: 'a', x: 5, y: 4 }] }).conflicts, ['/clips/a/x']);
  assert.deepEqual(mergeState(base, { ...local, clips: [] }, remote).conflicts, ['/clips/a']);
});

test('an operation made locally since the base stays first in newest-first history after a merge', () => {
  const base = { operations: [{ id: 'old' }], clips: [{ id: 'a' }] };
  const local = { operations: [{ id: 'mine' }, { id: 'old' }], clips: [{ id: 'a' }, { id: 'new-clip' }] };
  const remote = { operations: [{ id: 'theirs' }, { id: 'old' }], clips: [{ id: 'a' }, { id: 'their-clip' }] };
  const merged = mergeState(base, local, remote).value;
  assert.deepEqual(merged.operations.map(x => x.id), ['mine', 'theirs', 'old']);
  assert.deepEqual(merged.clips.map(x => x.id), ['a', 'their-clip', 'new-clip'], 'other lists keep remote order with new items after');
});
