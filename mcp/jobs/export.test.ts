// Export jobs against a real SharedCut server on a temporary data folder: Deliver's settings, a render downloaded
// (and resumed) to disk, cancel/retry, and a Resolve bridge bundle imported with its original uploaded.
import '../env.ts';
import { GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
// These tests check pixels and exports, not the host's optional system fonts.
GlobalFonts.registerFromPath(fileURLToPath(new URL('../../public/fonts/TikTokSans.ttf', import.meta.url)), 'Helvetica Neue');
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFrameLineServer } from '../../server/index.ts';
import { makeCube, cubeText } from '../../src/services/color.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'sharedcut-mcp-export-')), out = join(dataDir, 'out');
const app = createFrameLineServer({ dataDir: join(dataDir, 'data') });
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const signup = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Exporter', email: 'export@example.com', password: 'export test password' }) });
process.env.FRAME_LINE_URL = url;
process.env.FRAME_LINE_COOKIE = signup.headers.get('set-cookie')!.split(';')[0];
const { answer } = await import('../server.ts');
const { PRESETS, CODECS, QUALITIES, AUDIO, FPS, SIZES, renderRequest, download } = await import('./export.ts');
const { useEditorStore: store } = await import('../../src/state/store.ts');

test.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await answer({ method: 'tools/call', params: { name, arguments: args } }) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map(c => c.text).join('\n'), error: !!result.isError };
}
const ok = async (name: string, args: Record<string, unknown> = {}) => { const r = await tool(name, args); assert.equal(r.error, false, r.text); return r.text; };
const job = (kind: string, params: Record<string, unknown>, wait = 120) => ok('job', { kind, params, wait });

test('the choices match Deliver and what the server accepts', async () => {
  const deliver = await readFile(new URL('../../src/workspaces/DeliverWorkspace.tsx', import.meta.url), 'utf8');
  const media = await readFile(new URL('../../server/media.ts', import.meta.url), 'utf8');
  for (const p of PRESETS) assert.match(deliver, new RegExp(`name: '${p.name}'.*codec: '${p.codec}', resolution: '${p.resolution}', quality: '${p.quality}'`));
  for (const value of [...CODECS, ...QUALITIES]) { assert.ok(deliver.includes(`<option>${value}</option>`), value); assert.ok(media.includes(`'${value}'`), value); }
  for (const value of AUDIO.slice(0, -1)) { const [codec, rate] = value.split(' · '); assert.ok(deliver.includes(`>${codec}</option>`) && deliver.includes(`<option>${rate}</option>`), value); }
  assert.ok(deliver.includes(`${AUDIO.at(-1)}'`) && deliver.includes('· 48 kHz`'));
  assert.ok(deliver.includes(FPS.map(f => `'${f}'`).join(', ')));
  assert.ok(deliver.includes(`[projectResolution, ${SIZES.map(s => `'${s}'`).join(', ')}]`));
});

test('settings are built as Deliver builds them', () => {
  const s = {
    projectId: 'p', timelineId: 't', settings: { masterGain: -3 },
    projects: [{ id: 'p', name: 'My cut!', resolution: '1080 × 1920', fps: 25 }],
    timelines: [{ id: 't', projectId: 'p', name: 'Main', duration: 60 }],
    clips: [{ id: 'a', timelineId: 't', start: 2, duration: 10 }, { id: 'b', timelineId: 't', start: 12, duration: 4 }],
  } as never;
  const quick = renderRequest(s, {});
  assert.deepEqual({ name: quick.name, preset: quick.preset }, { name: 'My_cut__Final.mp4', preset: 'Quick Export' });
  assert.deepEqual(quick.settings, { destination: 'Server exports', resolution: '1080 × 1920', fps: '25', codec: 'H.264', quality: 'High · 20 Mb/s', masterGain: '-3', masterMuted: 'false', range: 'Entire timeline', rangeIn: '0', rangeOut: '16', duration: '16', timecodeIn: '00:00:00:00', timecodeOut: '00:00:16:00', sourceFrameRate: '25', audio: 'AAC · 320 kb/s · 48 kHz', subtitles: 'None', timeline: 'Main', timelineId: 't' });
  // A landscape preset on a vertical project keeps the project size; ProRes writes .mov.
  const master = renderRequest(s, { preset: 'master', audio: 'pcm24', clip: 'b', name: 'final.mp4' });
  assert.equal(master.preset, 'High Quality Master');
  assert.deepEqual([master.name, master.settings.resolution, master.settings.codec, master.settings.audio, master.settings.range, master.settings.rangeIn, master.settings.rangeOut], ['final.mov', '1080 × 1920', 'Apple ProRes 422 HQ', 'Linear PCM · 24-bit · 48 kHz', 'Selected clip', '12', '16']);
  const custom = renderRequest(s, { preset: 'youtube', resolution: '720x1280', in: 1, out: 3.5, audio: 'off' });
  assert.deepEqual([custom.preset, custom.settings.resolution, custom.settings.quality, custom.settings.audio, custom.settings.range], ['Custom', '720 × 1280', 'Maximum · 50 Mb/s', 'Disabled', 'In / Out range']);
  assert.throws(() => renderRequest(s, { audio: 'pcm16' }), /ProRes/);
  assert.throws(() => renderRequest(s, { codec: 'vp9' }), /not one of/);
  assert.throws(() => renderRequest(s, { in: 5, out: 5 }), /at least one frame/);
  assert.throws(() => renderRequest(s, { out: 61 }), /past the timeline/);
  assert.throws(() => renderRequest(s, { name: 'a/b' }), /without slashes/);
});

test('an export renders, downloads, resumes a partial download, retries and cancels', async () => {
  await ok('act', { do: [['createProject', { name: 'Export', description: '', shared: false }]] });
  await ok('act', { at: 0, do: [['addTitle', 3]] });
  const first = await job('export', { resolution: '320x180', out: 1, name: 'first', download: `${out}/` });
  assert.match(first, /^queued Custom · H\.264 320 × 180 24fps AAC · 320 kb\/s · 00:00:00:00→00:00:01:00 \(1s\) · first\.mp4\n@\w+ complete · first\.mp4 · saved .*first\.mp4 \(\d+ KB\)/);
  const file = join(out, 'first.mp4'), bytes = await readFile(file);
  assert.equal(bytes.subarray(4, 8).toString(), 'ftyp');
  const rendered = store.getState().renderJobs[0];
  // A broken-off download resumes from its .part with a Range request.
  const part = `${file}.${/[0-9a-f]{8}/.exec(rendered.id)![0]}.part`;
  await rm(file); await writeFile(part, bytes.subarray(0, 1000));
  let start = 0;
  const resumed = await download(rendered, out, got => { start ||= got; });
  assert.ok(start > 1000, 'it continued after the 1000 bytes already on disk');
  assert.deepEqual(await readFile(resumed.path), bytes);
  // Into a folder nothing is overwritten; a part already holding the whole file (416) is finished, not refetched.
  assert.match((await download(rendered, out)).path, /first \(2\)\.mp4$/);
  await rm(file); await writeFile(part, bytes);
  const whole = await download(rendered, out);
  assert.equal(whole.path, file); assert.deepEqual(await readFile(file), bytes);
  const handle = /@\w+/.exec(first)![0];
  assert.match(await job('exports', {}), new RegExp(`${handle} complete · first\\.mp4`));
  const retry = await job('exports', { job: handle, retry: true });
  assert.match(retry, new RegExp(`^@\\w+ queued \\(retry of ${handle}, current edit\\)\\n@\\w+ complete · first\\.mp4\\nsave it`));
  assert.match((await tool('job', { kind: 'exports', params: { job: handle, cancel: true } })).text, /complete; cancel would delete its file/);
  assert.match(await job('exports', { job: handle, delete: true }), /file deleted \(record stays\)/);
  assert.match((await tool('job', { kind: 'exports', params: { job: handle, delete: true } })).text, /nothing to cancel or delete/);
  assert.match((await tool('job', { kind: 'exports', params: { job: handle, download: out } })).text, /failed · Cancelled by user/);
  assert.match((await tool('job', { kind: 'export', params: { codec: 'h264', audio: 'pcm24' } })).text, /needs a ProRes codec/);
});

test('Resolve: bridge script, OTIO refusal on a title, and a bundle imported with its original', async () => {
  await mkdir(out, { recursive: true });
  assert.match(await job('resolve', { do: 'bridge', path: out }), /resolve-export\.lua\nin Resolve's Lua console: dofile\(".*resolve-export\.lua"\)/);
  assert.match(await readFile(join(out, 'resolve-export.lua'), 'utf8'), /^-- Run in Resolve's Lua console/);
  assert.match((await tool('job', { kind: 'resolve', params: { do: 'otio', path: out } })).text, /export titles as video/);
  const bundle = join(dataDir, 'bundle'), footage = join(dataDir, 'footage');
  await mkdir(bundle, { recursive: true }); await mkdir(footage, { recursive: true });
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=24000/1001:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(footage, 'source.mp4')]);
  // server/resolve.test.ts's bundle, with the original moved away from its recorded path.
  const manifest = { format: 'frameline-resolve', version: 1, name: 'Roundtrip', media: [{ id: 'm', name: 'source.mp4', properties: { 'File Path': '/moved/source.mp4', Type: 'Video', Frames: 48, FPS: 23.976 } }], timelines: [{ id: 't', name: 'Timeline', startFrame: 86400, endFrame: 86424, settings: { timelineFrameRate: 23.976 }, tracks: [{ kind: 'video', number: 1, name: 'V1', items: [{ id: 'c', name: 'source.mp4', mediaId: 'm', startFrame: 86400, durationFrames: 24, sourceStartFrame: 9, sourceEndFrame: 32, leftOffset: 10, enabled: true, properties: {}, nodes: [], lookExported: true, lookFile: 'c.cube' }] }] }] };
  const otio = { tracks: { children: [{ kind: 'Video', children: [{ OTIO_SCHEMA: 'Clip.2', name: 'source.mp4', source_range: { start_time: { value: 110, rate: 24000 / 1001 }, duration: { value: 24, rate: 24000 / 1001 } }, media_references: { DEFAULT_MEDIA: { available_range: { start_time: { value: 100, rate: 24000 / 1001 } } } }, effects: [] }] }] } };
  await writeFile(join(bundle, 'project.frameline.json'), JSON.stringify(manifest));
  await writeFile(join(bundle, 'timeline-1.otio'), JSON.stringify(otio));
  await writeFile(join(bundle, 'c.cube'), cubeText(makeCube(rgb => rgb, 2)));
  assert.match(await job('resolve', { do: 'import', path: bundle }), /"Roundtrip" · 1 sources \(0 uploaded, 1 missing: source\.mp4\)\n2 bundle files stored \(not stored: project\.drp\)/);
  const resumed = await job('resolve', { do: 'import', path: bundle, media: [footage] });
  assert.match(resumed, /^project (@\w+) "Roundtrip" · 1 sources \(1 uploaded\)/);
  const projectId = store.getState().projects.find(p => p.name === 'Roundtrip')!.id;
  assert.equal(store.getState().projects.filter(p => p.name === 'Roundtrip').length, 1, 'running it again resumes the same project');
  // The server records the original once the last chunk is stored.
  let uploaded = false;
  for (let i = 0; i < 50 && !uploaded; i++) { await ok('media'); uploaded = !!store.getState().media.find(m => m.projectId === projectId)?.sourceUrl; if (!uploaded) await new Promise(r => setTimeout(r, 200)); }
  assert.ok(uploaded, 'the original was uploaded');
  await ok('projects', { open: /@\w+/.exec(resumed)![0] });
  assert.match(await job('resolve', { do: 'otio', path: `${out}/` }), /SharedCut-timeline\.otio · \d+ warnings/);
  assert.equal(JSON.parse(await readFile(join(out, 'SharedCut-timeline.otio'), 'utf8')).OTIO_SCHEMA, 'Timeline.1');
});

test('Final Cut: the plan puts the import on Projects screens, class:true shares it, a clip not found is listed', async () => {
  const bundle = join(dataDir, 'fcp'), footage = join(dataDir, 'fcp-footage');
  await mkdir(bundle, { recursive: true }); await mkdir(footage, { recursive: true });
  execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(footage, 'A001.mp4')]);
  const asset = (id: string, path: string) => `<asset id="${id}" start="0s" duration="2s" hasVideo="1" format="r1"><media-rep kind="original-media" src="file://${path}"/></asset>`;
  await writeFile(join(bundle, 'Info.fcpxml'), `<fcpxml version="1.11"><resources><format id="r1" frameDuration="100/2500s" width="160" height="90"/>${asset('a', '/Volumes/Card/A001.mp4')}${asset('b', '/Volumes/Card/B002.mp4')}</resources>
<library><event name="E"><project name="Class Film" uid="MCP-1"><sequence format="r1" duration="4s" tcStart="0s"><spine><asset-clip ref="a" offset="0s" start="0s" duration="2s"/><asset-clip ref="b" offset="2s" start="0s" duration="2s"/></spine></sequence></project></event></library></fcpxml>`);
  assert.match(await job('fcp', { path: bundle, media: [footage], class: true }), /^project @\w+ "Class Film" · 2 sources \(1 uploaded, 1 not uploaded: B002\.mp4\)/);
  const project = store.getState().projects.find(p => p.name === 'Class Film')!;
  assert.deepEqual([project.shared, project.classRole], [true, 'Editor']);
  assert.deepEqual([project.fcpImport?.files, project.fcpImport?.uploaded, project.fcpImport?.received], [1, 1, (await readFile(join(footage, 'A001.mp4'))).length]);
  assert.match(project.fcpImport!.phase, /^(processing|ready)$/);
});
