import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPreviewCache } from './previewCache.ts';
import type { RenderRequest } from './media.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';

test('timeline previews skip a range with an active Depth clip and render the rest', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'frameline-preview-cache-'));
  try {
    const rendered: string[] = [], scheduled: Promise<void>[] = [];
    const cache = createPreviewCache(directory, (_id, work) => { scheduled.push(work(new AbortController().signal)); }, async request => { rendered.push(String(request.settings.rangeIn)); throw new Error('not rendered in this test'); });
    const asset: MediaAsset = { id: 'm', projectId: 'p', name: 'm.mp4', kind: 'video', binId: 'all', duration: 20, fps: 24, resolution: '320 × 180', size: '', status: 'ready', progress: 100, thumbnail: '' };
    const track: Track = { id: 'v1', timelineId: 't', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
    const clip = (id: string, start: number, effects: Clip['effects'] = []): Clip => ({ id, projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'm', name: id, start, duration: 4, sourceIn: 0, color: '', disabled: false, properties: { ...defaultProperties }, effects });
    const depth = { id: 'd', name: 'Depth', enabled: true, amount: 100, parameters: { blur: 50 } };
    const snapshot = (rangeIn: number, clips: Clip[]): Omit<RenderRequest, 'outputPath' | 'signal' | 'onProgress'> => ({
      project: { id: 'p', resolution: '320 × 180', fps: 24 } as Project, timeline: { id: 't', projectId: 'p', name: 't', duration: 12 }, tracks: [track], nodes: [],
      clips, assets: [{ asset, path: path.join(directory, 'missing.mp4') }], settings: { resolution: '320 × 180', fps: '24', codec: 'H.264', audio: 'Disabled', rangeIn: String(rangeIn), rangeOut: String(rangeIn + 4) },
    });
    const clips = [clip('plain', 0), clip('deep', 4, [depth])];
    const skipped = cache.request(snapshot(4, clips));
    assert.equal(skipped.status, 'skipped', 'the chunk holding the Depth clip is not rendered');
    assert.equal(cache.request(snapshot(4, clips)).status, 'skipped', 'and asking again does not queue it either');
    // Depth with every section off draws nothing, so it does not count; neither does one switched off.
    assert.equal(cache.request(snapshot(4, [clip('plain', 0), clip('deep', 4, [{ ...depth, parameters: { blur: 0 } }])])).status, 'preparing');
    assert.equal(cache.request(snapshot(0, clips)).status, 'preparing', 'the chunk before it renders as usual');
    // A composition renders its whole inner timeline, so a Depth clip two levels down skips the chunk too, wherever it sits.
    const nested = { ...snapshot(0, [clip('parent', 0), clip('middle', 0), { ...clip('inner', 8, [depth]), timelineId: 'inner' }]), timelines: [{ id: 't', projectId: 'p', name: 't', duration: 12 }, { id: 'middle', projectId: 'p', name: 'middle', duration: 4, composition: true }, { id: 'inner', projectId: 'p', name: 'inner', duration: 12, composition: true }] };
    nested.clips[0] = { ...nested.clips[0], mediaId: 'frameline-composition', properties: { ...defaultProperties, compositionId: 'middle' } };
    nested.clips[1] = { ...nested.clips[1], timelineId: 'middle', mediaId: 'frameline-composition', properties: { ...defaultProperties, compositionId: 'inner' } };
    nested.tracks = [track, { ...track, id: 'mv', timelineId: 'middle' }, { ...track, id: 'iv', timelineId: 'inner' }];
    nested.clips[1].trackId = 'mv'; nested.clips[2].trackId = 'iv';
    assert.equal(cache.request(nested).status, 'skipped', 'a Depth inside a nested composition is never baked for a preview');
    await Promise.all(scheduled);
    assert.deepEqual(rendered.sort(), ['0', '4'], 'only the chunks without an active Depth reached the renderer');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
