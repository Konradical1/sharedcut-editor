import assert from 'node:assert/strict';
import test from 'node:test';
import { findUnfinishedUpload, uploadSource } from './upload.ts';
import type { MediaAsset } from '../state/models.ts';

test('reselecting an interrupted file resumes its verified offset and reports progress', async t => {
  const file = new File(['abcdefghij'], 'clip.bin', { lastModified: 123 });
  const assets = [
    { id: 'ready', name: file.name, status: 'ready' },
    { id: 'different', name: file.name, status: 'uploading' },
    { id: 'interrupted', name: file.name, status: 'uploading' },
  ] as MediaAsset[];
  const requests: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    requests.push(`${init.method ?? 'GET'} ${url}`);
    if (url.includes('/different/')) return Response.json({ offset: 0, complete: false, metadata: { fingerprint: 'clip.bin:10:999' } });
    if (init.method === 'PUT') {
      assert.equal((init.headers as Record<string, string>)['Upload-Offset'], '4');
      assert.equal(new TextDecoder().decode(init.body as ArrayBuffer), 'efghij');
      return Response.json({ offset: 10, complete: true });
    }
    return Response.json({ offset: 4, complete: false, metadata: { fingerprint: 'clip.bin:10:123' } });
  });
  const id = await findUnfinishedUpload(file, assets);
  assert.equal(id, 'interrupted');
  const progress: number[] = [];
  let resumedBytes = 0;
  await uploadSource(id!, file, value => progress.push(value), undefined, detail => { resumedBytes = detail.resumedBytes ?? 0; });
  assert.equal(resumedBytes, 4, 'speed and transferred bytes must exclude previously uploaded data');
  assert.deepEqual(progress, [40, 100]);
  assert.equal(requests.some(request => request.includes('/ready/')), false);
  assert.equal(await findUnfinishedUpload(new File(['x'], 'other.bin'), assets), undefined);
});

test('a timed-out chunk retries using a fresh bounded request', async t => {
  let puts = 0;
  const signals = new Set<AbortSignal>();
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(signals.has(init.signal), false);
    signals.add(init.signal);
    if (init.method === 'PUT' && ++puts === 1) throw new DOMException('Transfer timed out', 'TimeoutError');
    return Response.json({ offset: init.method === 'PUT' ? 3 : 0, complete: init.method === 'PUT' });
  });
  const progress: number[] = [];
  await uploadSource('source', new File(['abc'], 'clip.bin'), value => progress.push(value));
  assert.equal(puts, 2);
  assert.deepEqual(progress, [0, 100]);
});

test('the queue shows all files, bounds concurrency, pauses a stalled file, and resumes without duplicates', async t => {
  const { enqueueUploads, pauseUpload, resumeUpload, resetUploads, uploadQueue } = await import('./upload.ts');
  const { connection } = await import('./api.ts');
  resetUploads();
  t.mock.method(connection, 'flush', async () => {});
  t.mock.method(connection, 'refresh', async () => {});
  const names = new Map<string, string>();
  let blocked = true, active = 0, maxActive = 0, created = 0;
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!condition()) { assert.ok(Date.now() < deadline, 'queue failed to advance'); await new Promise(resolve => setTimeout(resolve, 5)); }
  };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    if (url.startsWith('/api/media?')) {
      const params = new URL(url, 'http://localhost').searchParams;
      names.set(params.get('id')!, params.get('name')!); created++;
      return Response.json({});
    }
    const id = url.split('/')[3];
    if (init.method === 'PUT') {
      active++; maxActive = Math.max(active, maxActive);
      try {
        if (names.get(id) === 'one.bin' && blocked) await new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
        return Response.json({ offset: 3, complete: true });
      } finally { active--; }
    }
    return Response.json({ offset: 0, complete: false });
  });
  try {
    const files = ['one.bin','two.bin','three.bin'].map(name => new File(['abc'], name));
    enqueueUploads('project', files, []);
    enqueueUploads('project', files, []);
    assert.equal(uploadQueue.getState().jobs.length, 3);
    await waitFor(() => uploadQueue.getState().jobs.filter(job => job.status === 'uploaded').length === 2);
    const first = uploadQueue.getState().jobs[0];
    pauseUpload(first.key);
    await waitFor(() => active === 0);
    assert.equal(uploadQueue.getState().jobs[0].status, 'paused');
    blocked = false;
    resumeUpload(first.key);
    await waitFor(() => uploadQueue.getState().jobs.every(job => job.status === 'uploaded'));
    assert.equal(created, 3);
    assert.ok(maxActive <= 2);
    assert.ok(uploadQueue.getState().jobs.every(job => !job.file), 'completed jobs release file handles');
  } finally { resetUploads(); }
});
