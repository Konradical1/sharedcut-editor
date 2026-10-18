import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameLineServer } from './index.ts';

test('desktop installers and update feeds come from <data>/downloads, and nothing outside it does', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-downloads-'));
  await mkdir(join(dataDir, 'downloads'));
  await writeFile(join(dataDir, 'downloads', 'latest-mac.yml'), 'version: 1.0.0\n');
  await writeFile(join(dataDir, 'downloads', 'SharedCut-1.0.0-arm64.dmg'), 'dmg bytes');
  await writeFile(join(dataDir, 'secret.txt'), 'not for download');
  await writeFile(join(dataDir, 'downloads', '.hidden'), 'hidden');
  const app = createFrameLineServer({ dataDir });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const feed = await fetch(`${origin}/download/latest-mac.yml`);
    assert.equal(feed.status, 200);
    assert.equal(await feed.text(), 'version: 1.0.0\n');
    assert.match(feed.headers.get('cache-control')!, /no-cache/, 'An installed app sees a new release as soon as it is published.');
    const dmg = await fetch(`${origin}/download/SharedCut-1.0.0-arm64.dmg`);
    assert.equal(dmg.status, 200);
    assert.match(dmg.headers.get('content-disposition')!, /attachment; filename="SharedCut-1.0.0-arm64.dmg"/);
    await dmg.arrayBuffer();
    assert.equal((await fetch(`${origin}/download/SharedCut-1.0.0-arm64.dmg`, { headers: { range: 'bytes=0-2' } })).status, 206, 'The updater resumes downloads with ranges.');
    assert.equal((await fetch(`${origin}/download/missing.dmg`)).status, 404);
    // Anything else under /download/ is the ordinary page or a 404, never a file from beside or inside the folder.
    for (const path of ['/download/..%2Fsecret.txt', '/download/%2e%2e/secret.txt', '/download/.hidden'])
      assert.ok(!['not for download', 'hidden'].includes(await (await fetch(`${origin}${path}`)).text()), path);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
