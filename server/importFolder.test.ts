import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createFrameLineServer } from './index.ts';

const exec = promisify(execFile);

test('import-folder signs in from FRAME_LINE_COOKIE, creates a vertical project by delta once, and reuses a project by name', { timeout: 60000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-import-')), footage = join(dataDir, 'footage');
  delete process.env.FRAME_LINE_SIGNUP_CODE;
  const app = createFrameLineServer({ dataDir: join(dataDir, 'data') });
  try {
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const signup = await fetch(`${base}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Agent', email: 'agent@example.test', password: 'import-test-password-2026' }) });
    assert.equal(signup.status, 201, await signup.text());
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const state = async () => (await (await fetch(`${base}/api/state`, { headers: { cookie } })).json());
    await mkdir(footage);
    await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', join(footage, 'tone.wav')]);
    const run = (name: string) => exec(process.execPath, ['scripts/import-folder.mjs', '--name', name, footage], { env: { ...process.env, FRAME_LINE_COOKIE: cookie, FRAME_LINE_URL: base } });
    await run('fisch.builds Part 1');
    await run('fisch.builds Part 1');
    let view = await state();
    const reels = view.state.projects.filter((p: { name: string }) => p.name === 'fisch.builds Part 1');
    assert.equal(reels.length, 1, 'a rerun resumes instead of duplicating');
    assert.equal(reels[0].resolution, '1080 × 1920'); assert.equal(reels[0].fps, 30);
    assert.equal(view.state.timelines.find((t: { projectId: string }) => t.projectId === reels[0].id).duration, 60);
    assert.equal(view.state.media.filter((m: { projectId: string }) => m.projectId === reels[0].id).length, 1);

    // A project made in the browser has a random id and an empty timeline.
    const ui = { id: 'project-from-ui', name: 'Made in UI', description: '', thumbnail: '', modifiedAt: Date.now(), duration: 0, resolution: '1080 × 1920', fps: 30, shared: false, status: 'In progress', members: [] };
    // Background preparation keeps bumping the revision, so retry like the scripts do.
    for (let status = 409; status === 409;) {
      view = await state();
      status = (await fetch(`${base}/api/state`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ revision: view.revision, delta: { projects: { upsert: [ui], remove: [] }, timelines: { upsert: [{ id: 'timeline-from-ui', projectId: ui.id, name: 'Main', duration: 0 }], remove: [] } } }) })).status;
      assert.ok(status === 200 || status === 409, `PATCH ${status}`);
    }
    await run('Made in UI');
    view = await state();
    assert.equal(view.state.projects.filter((p: { name: string }) => p.name === 'Made in UI').length, 1, 'the browser project is reused by name');
    assert.equal(view.state.timelines.find((t: { id: string }) => t.id === 'timeline-from-ui').duration, 60);
    assert.ok(view.state.media.some((m: { projectId: string }) => m.projectId === ui.id));
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
