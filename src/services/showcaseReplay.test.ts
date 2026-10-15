import assert from 'node:assert/strict';
import test from 'node:test';
import { compileReplay, type HistoryBundle } from './showcaseReplay.ts';

test('a replay rewinds history to empty, replays it to the saved state, and publishes first names only', () => {
  const clip = { id: 'c1', projectId: 'p', timelineId: 't1', trackId: 'v1', mediaId: 'm1', name: 'Goal', start: 5, duration: 3, sourceIn: 0, color: '#4977a0', disabled: false, properties: {}, effects: [] };
  const bundle = {
    project: { id: 'p', name: 'Girls Soccer', modifiedAt: 3 },
    media: [{ id: 'm1', name: 'Goal.mp4', kind: 'video', duration: 9, fps: 30 }],
    clips: [clip], tracks: [{ id: 'v1', timelineId: 't1', name: 'Main picture', kind: 'video', number: 1 }], nodes: [], comments: [], timelines: [{ id: 't1' }],
    operations: [
      { userId: 'u1', timestamp: 1, type: 'ClipAdded', oldState: [{ collection: 'clips', id: 'c1', value: null }], newState: [{ collection: 'clips', id: 'c1', value: { ...clip, start: 0 }, replace: true }] },
      { userId: 'u2', timestamp: 2, type: 'ClipMoved', oldState: [{ collection: 'clips', id: 'c1', value: { start: 0 } }], newState: [{ collection: 'clips', id: 'c1', value: { start: 5 } }] },
    ],
  } as unknown as HistoryBundle;
  const users = [{ id: 'u1', name: 'Test', color: '#EBC876' }, { id: 'u2', name: 'Sophie Busse', color: '#EBC876' }] as never;
  const { replay, verification } = compileReplay(bundle, users);
  assert.deepEqual(verification.differences, []);
  assert.equal(verification.baselineClips, 0);
  assert.deepEqual(replay.authors.map(a => a.name).sort(), ['Konrad', 'Sophie']);
  assert.notEqual(replay.authors[0].color, replay.authors[1].color);
  assert.equal(replay.frames[0].clips.length, 0);
  assert.equal(replay.frames.at(-1)!.clips[0].start, 5);
  assert.ok(!JSON.stringify(replay).includes('Busse'));
});
