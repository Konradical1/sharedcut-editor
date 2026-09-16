import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { parseImportLink, youtubeThumbnail } from './linkImport.ts';
import { createFrameLineServer } from './index.ts';

test('link validation only accepts canonical single-video and single-track destinations', () => {
  assert.equal(parseImportLink('https://youtu.be/jNQXAC9IVRw?si=abc').url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
  assert.equal(youtubeThumbnail('https://youtu.be/jNQXAC9IVRw?si=abc'), 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg');
  assert.equal(parseImportLink('https://m.youtube.com/shorts/jNQXAC9IVRw').mode, 'video');
  assert.equal(parseImportLink('https://open.spotify.com/intl-de/track/0VjIjW4GlUZAMYd2vXMi3b?si=abc').mode, 'audio');
  for (const url of ['file:///etc/passwd', 'https://127.0.0.1/watch?v=jNQXAC9IVRw', 'https://youtube.com.evil.test/watch?v=jNQXAC9IVRw', 'https://youtube.com@evil.test/watch?v=jNQXAC9IVRw', 'https://www.youtube.com:8443/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/playlist?list=abc', 'https://open.spotify.com/album/0VjIjW4GlUZAMYd2vXMi3b']) assert.throws(() => parseImportLink(url));
  assert.throws(() => parseImportLink('https://youtu.be/jNQXAC9IVRw', 'shell'));
  assert.throws(() => parseImportLink('https://youtu.be/jNQXAC9IVRw', 'video', 999));
});

test('project link imports prepare real media, retain sources, retry failures, cancel and enforce access', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sharedcut-links-'));
  const interpreter = join(directory, 'importer.cjs'), control = join(directory, 'control'), fixture = join(directory, 'source.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=24:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', fixture]);
  await promisify(execFile)(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-i', fixture, '-vn', '-c:a', 'copy', join(directory, 'source.m4a')]);
  await writeFile(control, 'success');
  // Stand in for the Python importer without a `#!` line, which Windows cannot spawn. Node is the
  // interpreter and this module is preloaded through NODE_OPTIONS, so it runs and exits before node
  // ever tries to read the .py path it was handed. The importer's own arguments are counted from
  // the end of argv, which is the same under a preload as it was under a shebang.
  await writeFile(interpreter, `const fs = require('node:fs'), path = require('node:path');
const [, , mode, , temporary] = process.argv.slice(-7);
const control = fs.readFileSync(${JSON.stringify(control)}, 'utf8');
if (control === 'fail') { console.log(JSON.stringify({type:'error',message:'Source temporarily unavailable'})); process.exit(1); }
if (control === 'wait') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
else {
 const extension = mode === 'audio' ? 'm4a' : 'mp4';
 fs.copyFileSync(path.join(${JSON.stringify(directory)}, 'source.'+extension), path.join(temporary, 'media.'+extension));
 console.log(JSON.stringify({type:'source',title:'Imported sample',url:'https://www.youtube.com/watch?v=jNQXAC9IVRw',matchedTitle:'Actual recording'}));
 console.log(JSON.stringify({type:'progress',percent:50}));
 console.log(JSON.stringify({type:'complete',filename:'media.'+extension,title:'Imported sample'}));
 process.exit(0);
}
`);
  const previous = process.env.FRAME_LINE_IMPORT_PYTHON, previousOptions = process.env.NODE_OPTIONS;
  process.env.FRAME_LINE_IMPORT_PYTHON = process.execPath;
  process.env.NODE_OPTIONS = `${previousOptions ? previousOptions + ' ' : ''}--require ${JSON.stringify(interpreter)}`;
  const app = createFrameLineServer({ dataDir: join(directory, 'data') });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let cookie = '';
  const request = async (route: string, method = 'GET', body?: unknown, auth = cookie) => {
    const response = await fetch(base + '/api' + route, { method, headers: { cookie: auth, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const wait = async (id: string, status: string) => {
    for (let i = 0; i < 150; i++) {
      const asset = (await request('/state')).data.state.media.find((item: { id: string }) => item.id === id);
      if (asset.status === status) return asset;
      if (asset.status === 'failed' && status === 'ready') assert.fail(asset.error);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Media did not become ${status}`);
  };
  try {
    const signup = await request('/auth/signup', 'POST', { name: 'Link Tester', email: 'links@example.com', password: 'a long test password', inviteCode: process.env.FRAME_LINE_SIGNUP_CODE });
    assert.equal(signup.status, 201);
    cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const state = (await request('/state')).data;
    state.state.projects.push({ id: 'link-project', name: 'Links', description: '', shared: false, thumbnail: '', modifiedAt: Date.now(), duration: 0, resolution: '1920 × 1080', fps: 24, status: 'In progress', members: [{ userId: signup.data.user.id, role: 'Owner' }] });
    assert.equal((await request('/state', 'PUT', state)).status, 200);
    const body = { projectId: 'link-project', url: 'https://youtu.be/jNQXAC9IVRw', mode: 'video', quality: 720 };
    assert.equal((await request('/media/import-link', 'POST', body, '')).status, 401);
    assert.equal((await request('/media/import-link', 'POST', { ...body, projectId: 'other' })).status, 404);
    assert.equal((await request('/media/import-link', 'POST', { ...body, url: 'https://localhost/' })).status, 400);
    const started = await request('/media/import-link', 'POST', body);
    assert.equal(started.status, 202);
    assert.equal(started.data.asset.thumbnail, 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg', 'The actual YouTube poster is available while downloading.');
    const ready = await wait(started.data.asset.id, 'ready');
    assert.equal(ready.kind, 'video'); assert.ok(ready.hasAudio); assert.ok(ready.proxyUrl);
    assert.equal(ready.matchedSourceTitle, 'Actual recording');
    assert.equal(ready.importLink.url, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
    assert.equal((await fetch(base + ready.sourceUrl, { headers: { cookie } })).status, 200);
    assert.ok(!(await readdir(join(directory, 'data/media', ready.id))).some(name => name.startsWith('download-')));
    await writeFile(control, 'fail');
    const failed = (await request('/media/import-link', 'POST', { ...body, url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b' })).data.asset;
    assert.equal(failed.importLink.mode, 'audio');
    assert.match((await wait(failed.id, 'failed')).error, /temporarily unavailable/);
    await writeFile(control, 'success');
    assert.equal((await request(`/media/${failed.id}/retry`, 'POST')).status, 202);
    const audio = await wait(failed.id, 'ready');
    assert.equal(audio.kind, 'audio'); assert.ok(audio.waveform.length > 0);
    await writeFile(control, 'wait');
    const pending = (await request('/media/import-link', 'POST', body)).data.asset;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await request(`/media/${pending.id}/cancel`, 'POST')).status, 200);
    assert.match((await wait(pending.id, 'failed')).error, /cancel/i);
    assert.equal((await request(`/media/${pending.id}`, 'DELETE')).status, 200);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.FRAME_LINE_IMPORT_PYTHON; else process.env.FRAME_LINE_IMPORT_PYTHON = previous;
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    await rm(directory, { recursive: true, force: true });
  }
});
