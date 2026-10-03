import test from 'node:test';
import assert from 'node:assert/strict';
import type { Clip, MediaAsset } from '../state/models.ts';
import type { DepthRun } from './depth.ts';
import { createDepthPreview, depthAtSource, depthState, ensureDepthRun, rememberDepth } from './depthPreview.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const until = async (done: () => boolean) => { for (let i = 0; i < 200 && !done(); i++) await tick(); assert.ok(done()); };

test('depth frames come from the decoded picture timestamp; a missing frame falls back one frame at most', async () => {
  // Source frames 64..191 at 24 fps, analysed as two 64-frame segments.
  const run: DepthRun = { key: 'a'.repeat(64), status: 'ready', progress: 100, mediaId: 'm', first: 64, frames: 128, times: Array.from({ length: 128 }, (_, i) => (64 + i) / 24), width: 4, height: 2, lo: 0, hi: 1, near: .9, far: .1, segments: [{ n: 0, first: 64, count: 64 }, { n: 1, first: 128, count: 64 }], next: 2 };
  const posts: string[] = [], downloads: string[] = [], decodes: { from: number; count: number }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === '/api/depth' && init?.method === 'POST') { posts.push(String(init.body)); return new Response(JSON.stringify(run), { headers: { 'Content-Type': 'application/json' } }); }
    if (url.includes('/preview/')) { downloads.push(url); return new Response(new Uint8Array([0, 0, 0, 1])); }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  // The worker answers with a frame per requested offset whose bytes say which offset it was.
  globalThis.Worker = class { onmessage?: (event: { data: unknown }) => void; postMessage(message: { id: number; from: number; count: number }) { decodes.push({ from: message.from, count: message.count }); queueMicrotask(() => { for (let i = message.from; i < message.from + message.count; i++) this.onmessage?.({ data: { type: 'frame', id: message.id, index: i, data: new Uint8Array(8).fill(i), width: 4, height: 2 } }); this.onmessage?.({ data: { type: 'done', id: message.id } }); }); } terminate() {} } as unknown as typeof Worker;
  const asset = { id: 'm', kind: 'video', fps: 24, duration: 10, status: 'ready', resolution: '64 × 36' } as MediaAsset;
  const clip = { id: 'c', projectId: 'p', mediaId: 'm', start: 0, duration: 2, sourceIn: 3, properties: {}, effects: [{ id: 'e', name: 'Depth', enabled: true, amount: 100 }] } as unknown as Clip;
  ensureDepthRun(clip, asset);
  await until(() => depthState('c')?.status === 'ready');
  let ready = 0;
  const preview = createDepthPreview(() => { ready++; });
  const at = (frame: number) => run.times[frame - 64];

  assert.deepEqual(preview.frame('c', at(74)), { state: 'loading' }, 'nothing decoded yet');
  await until(() => ready > 0);
  const exact = preview.frame('c', at(74) + .4 / 24);
  assert.equal(exact.state, 'ready');
  assert.equal(exact.state === 'ready' && exact.pixels.key, `${run.key}:74`, 'a timestamp inside the frame picks that frame');
  assert.equal(exact.state === 'ready' && exact.pixels.data[0], 10, 'offset 10 of segment 0');
  assert.deepEqual(decodes[0], { from: 10, count: 16 }, 'decodes a window forward from the frame');

  // Offsets 10..25 are decoded: offset 26 is not, so its frame shows offset 25's depth, never older.
  const stale = preview.frame('c', at(90));
  assert.equal(stale.state === 'ready' && stale.pixels.key, `${run.key}:89`);
  assert.deepEqual(preview.frame('c', at(160)), { state: 'loading' }, 'two frames old is no depth at all');
  assert.deepEqual(preview.frame('c', at(64) - .5), { state: 'analyzing' }, 'before the run: not covered');
  assert.deepEqual(preview.frame('nobody', 0), { state: 'none' });

  // Past three quarters of segment 0 the next segment downloads.
  preview.frame('c', at(64 + 50));
  await until(() => downloads.some(url => url.includes('/preview/1.mp4')));

  // A trim inside the one-second handles keeps the run; a slip past them asks again.
  ensureDepthRun({ ...clip, sourceIn: 4 }, asset);
  await tick();
  assert.equal(posts.length, 1);
  ensureDepthRun({ ...clip, sourceIn: 7 }, asset);
  await until(() => posts.length === 2);
  await until(() => depthState('c')?.status === 'ready');

  // The focus picker reads the frame drawn last.
  rememberDepth('c', { pixels: { data: new Uint8Array([230, 230, 25, 25, 230, 230, 25, 25]), width: 4, height: 2, key: 'x' }, near: .9, far: .1 });
  assert.ok(depthAtSource('c', .1, .5)! < 5 && depthAtSource('c', .9, .5)! > 95);
  assert.equal(depthAtSource('c', 1.2, .5), undefined);
  preview.dispose();
});
