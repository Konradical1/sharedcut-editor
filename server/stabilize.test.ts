import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readdir, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSettings, renderStabilized, stabilizeAnalysis, stabilizeAnalysisIdentity, stabilizeIdentity, stabilizePython, trimStabilizeCache } from './stabilize.ts';

const settings = normalizeSettings(undefined);

test('stabilize identities follow input, range and settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stabilize-id-'));
  const input = join(directory, 'clip.mp4'); await writeFile(input, 'video');
  const a = await stabilizeAnalysisIdentity(input, 0, 4);
  assert.equal(a, await stabilizeAnalysisIdentity(input, 0, 4));
  assert.notEqual(a, await stabilizeAnalysisIdentity(input, 0, 5));
  await writeFile(input, 'other video');
  assert.notEqual(a, await stabilizeAnalysisIdentity(input, 0, 4));
  const render = await stabilizeIdentity(a, settings, 0, 4, true);
  assert.equal(render, await stabilizeIdentity(a, { ...settings, smoothness: 50.0000001 }, 0, 4, true));
  assert.notEqual(render, await stabilizeIdentity(a, { ...settings, smoothness: 80 }, 0, 4, true));
  assert.notEqual(render, await stabilizeIdentity(a, settings, 0, 4, false));
  assert.deepEqual(normalizeSettings({ smoothness: Number.NaN, zoom: 12 } as never), { ...settings, zoom: 12 });
  await rm(directory, { recursive: true, force: true });
});

test('cached results skip the worker and the interpreter honours the env override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stabilize-cache-'));
  const input = join(directory, 'clip.mp4'); await writeFile(input, 'video');
  const previous = process.env.FRAME_LINE_STABILIZE_PYTHON;
  process.env.FRAME_LINE_STABILIZE_PYTHON = join(directory, 'missing-python');
  try {
    assert.equal(stabilizePython(), join(directory, 'missing-python'));
    const key = await stabilizeAnalysisIdentity(input, 0, 2);
    await writeFile(join(directory, `${key}.path.json`), '{}');
    const progress: number[] = [];
    assert.deepEqual(await stabilizeAnalysis({ input, directory, from: 0, to: 2, onProgress: p => progress.push(p) }), { key, output: join(directory, `${key}.path.json`) });
    assert.deepEqual(progress, [100]);
    const renderKey = await stabilizeIdentity(key, settings, 0, 2, true);
    await writeFile(join(directory, `${renderKey}.mp4`), 'mp4');
    const rendered = await renderStabilized({ input, directory, range: { from: 0, to: 2 }, from: 0, to: 2, settings, preview: true });
    assert.equal(rendered.output, join(directory, `${renderKey}.mp4`));
    await assert.rejects(renderStabilized({ input, directory, range: { from: 0, to: 2 }, from: 1, to: 3, settings, preview: true }), /inside the analysed range/);
    await assert.rejects(renderStabilized({ input, directory, range: { from: 0, to: 2 }, from: 0, to: 1, settings, preview: true }));
    assert.equal((await readdir(directory)).filter(name => name.startsWith('.stabilize-')).length, 0, 'temporary directories are cleaned up');
  } finally { if (previous === undefined) delete process.env.FRAME_LINE_STABILIZE_PYTHON; else process.env.FRAME_LINE_STABILIZE_PYTHON = previous; await rm(directory, { recursive: true, force: true }); }
});

test('trimming evicts the oldest finished previews only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stabilize-trim-'));
  const names = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
  for (const [index, name] of names.entries()) { await writeFile(join(directory, `${name}.mp4`), Buffer.alloc(100)); await utimes(join(directory, `${name}.mp4`), 1000 + index, 1000 + index); }
  await writeFile(join(directory, `${names[0]}.path.json`), '{}'); await writeFile(join(directory, `${names[0]}.mov`), Buffer.alloc(100));
  await trimStabilizeCache(directory, new Set([names[0]]), 250);
  assert.deepEqual((await readdir(directory)).sort(), [`${names[0]}.mov`, `${names[0]}.mp4`, `${names[0]}.path.json`, `${names[2]}.mp4`]);
  await rm(directory, { recursive: true, force: true });
});
