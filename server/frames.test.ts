// GET /api/frames: one composited frame through the export renderer (server/previewCache.ts createStillCache).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStillCache, mediaStill, stillSettings, stillSize, StillFailed, StillSkipped, PreviewBusyError } from './previewCache.ts';
import { renderTimeline, run, type RenderRequest } from './media.ts';
import type { Clip, GradeNode, MediaAsset, Project, Timeline, Track } from '../src/state/models.ts';
import { primaryDefaults } from '../src/services/color.ts';
import { defaultProperties } from '../src/state/demo.ts';
import { streamFile } from './index.ts';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

test('a still keeps the project shape on even sides, wide, scope and vertical alike', () => {
  for (const [resolution, edge] of [['1920 × 1080', 512], ['2048 × 858', 256], ['2048 × 858', 512], ['1080 × 1920', 256], ['3840 × 2160', 1280], ['1998 × 1080', 128]] as const) {
    const [w, h] = stillSize(resolution, edge), [pw, ph] = resolution.split(' × ').map(Number);
    assert.ok(w % 2 === 0 && h % 2 === 0 && Math.min(w, h) >= 16, `${resolution} at ${edge}: ${w}×${h}`);
    assert.ok(Math.abs(w / h - pw / ph) <= .01, `${resolution} at ${edge}: ${w}×${h} keeps the ratio`);
    assert.ok(Math.max(w, h) >= edge && Math.max(w, h) <= edge + 128, `${resolution} at ${edge}: long edge ${Math.max(w, h)}`);
  }
  const at = stillSettings({ fps: 24, resolution: '1920 × 1080' }, 2, 5, 512);
  assert.deepEqual([at.frame, at.settings.rangeIn, at.settings.rangeOut], [47, String(47 / 24), '2'], 'past the end is the last whole frame');
  assert.equal(stillSettings({ fps: 24, resolution: '1920 × 1080' }, 2, 1.03, 512).frame, 24, 'snapped down to the frame grid');
});

test('a frame renders graded through the export renderer, is cached, and skips what bakes whole clips', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-frames-'));
  try {
    const video = path.join(dir, 'red.mkv');
    await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xc82828:s=320x180:r=24:d=2', '-c:v', 'ffv1', video]);
    const project = { id: 'p', resolution: '320 × 180', fps: 24 } as Project;
    const timeline = { id: 't', projectId: 'p', name: 'T', duration: 2 } as Timeline;
    const track = { id: 'v1', timelineId: 't', name: 'V1', number: 1, kind: 'video', muted: false, hidden: false, solo: false, locked: false, gain: 0, pan: 0 } as Track;
    const asset = { id: 'm', projectId: 'p', name: 'Red', kind: 'video', duration: 2, resolution: '320 × 180', fps: 24, hasAudio: false, inputProfile: 'Rec.709' } as MediaAsset;
    const clip: Clip = { id: 'a', projectId: 'p', timelineId: 't', trackId: 'v1', mediaId: 'm', name: 'A', start: 0, duration: 2, sourceIn: 0, color: '', disabled: false, effects: [], properties: {} };
    const grey: GradeNode = { id: 'n', projectId: 'p', clipId: 'a', name: 'Mono', kind: 'serial', enabled: true, parameters: { ...primaryDefaults, saturation: 0 } };
    const base = { project, timeline, tracks: [track], clips: [clip], nodes: [grey], assets: [{ asset, path: video }] };
    const renders: RenderRequest[] = [], logs: string[] = [];
    let released = 0;
    const cache = createStillCache(path.join(dir, 'frames'), request => { renders.push(request); return renderTimeline(request); }, { log: line => logs.push(line), admit: () => ({ ok: true, release: () => { released++; } }) });
    const still = stillSettings(project, 2, .5, 256);
    const file = await cache.still({ ...base, settings: still.settings });
    assert.deepEqual([...(await readFile(file)).subarray(0, 3)], [0xff, 0xd8, 0xff], 'a JPEG');
    assert.equal((await run(ffprobe, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file])).toString().trim(), `${still.width},${still.height}`);
    const pixel = await run(ffmpeg, ['-v', 'error', '-i', file, '-vf', 'crop=2:2:100:60', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { binary: true });
    assert.ok(Math.max(...pixel) - Math.min(...pixel) < 20, `the grade is applied: ${[...pixel]}`);
    assert.equal(renders[0].threads, 4, 'one pass on preview threads');
    assert.equal(await cache.still({ ...base, settings: still.settings }), file, 'the same frame again');
    assert.equal(renders.length, 1, 'is served from the cache');
    assert.equal(released, 1, 'and its guard slot was given back');

    // An untouched file on its own timeline is its source picture: red, not graded.
    const source = await cache.still({ ...mediaStill(project, asset, video), settings: stillSettings(project, 2, 1, 256).settings });
    const red = await run(ffmpeg, ['-v', 'error', '-i', source, '-vf', 'crop=2:2:100:60', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { binary: true });
    assert.ok(red[0] > 150 && red[2] < 90, `the source is ungraded: ${[...red]}`);

    const skipped = async (clips: Clip[]) => { try { await cache.still({ ...base, clips, settings: still.settings }); return 'rendered'; } catch (error) { return error instanceof StillSkipped ? error.live : String(error); } };
    assert.equal(await skipped([{ ...clip, mediaId: 'frameline-composition', properties: { compositionId: 'inner' } }]), 'composition');
    assert.equal(await skipped([{ ...clip, effects: [{ id: 's', name: 'Stabilize', enabled: true, amount: 100 }] }]), 'bake');
    assert.equal(await skipped([{ ...clip, properties: { opticalFlow: true } }]), 'bake');

    // The export's own refusal reaches the caller; an FFmpeg failure naming host paths does not.
    const failing = (message: string) => createStillCache(path.join(dir, 'frames'), async () => { throw new Error(message); }, { log: line => logs.push(line) });
    const other = { ...base, settings: stillSettings(project, 2, 1.5, 256).settings };
    await assert.rejects(failing('A: a transition cannot sit on a keyframed clip.').still(other), (error: Error) => error instanceof StillFailed && error.message === 'A: a transition cannot sit on a keyframed clip.');
    for (const leak of [`ffmpeg failed: ${path.join(dir, 'x.mov')}: Invalid data`, 'Error opening C:\\Users\\jdoe\\data\\x.mov', 'cannot read \\\\nas\\share\\x.mov']) {
      await assert.rejects(failing(leak).still(other), (error: Error) => error instanceof StillFailed && error.message === 'This frame could not be rendered.', leak);
    }
    assert.ok(logs.some(line => line.includes('Invalid data')), 'the detail is logged');

    const busy = createStillCache(path.join(dir, 'frames'), async () => {}, { admit: () => ({ ok: false, reason: 'Memory is short.' }) });
    await assert.rejects(busy.still(other), (error: Error) => error instanceof PreviewBusyError && error.reason === 'Memory is short.');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a frame inside a transition window is the blend, not black, a frozen side included', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-frames-'));
  try {
    const red = path.join(dir, 'red.mkv'), blue = path.join(dir, 'blue.mkv');
    await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xc82828:s=320x180:r=24:d=4', '-c:v', 'ffv1', red]);
    await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2828c8:s=320x180:r=24:d=4', '-c:v', 'ffv1', blue]);
    const project = { id: 'p', resolution: '320 × 180', fps: 24 } as Project;
    const media = (id: string) => ({ id, projectId: 'p', name: id, kind: 'video', duration: 4, resolution: '320 × 180', fps: 24, hasAudio: false, inputProfile: 'Rec.709' }) as MediaAsset;
    const clip = (id: string, mediaId: string, start: number, extra: Partial<Clip> = {}): Clip => ({ id, projectId: 'p', timelineId: 't', trackId: 'v1', mediaId, name: id, start, duration: 2, sourceIn: 1, color: '', disabled: false, effects: [], properties: { ...defaultProperties }, ...extra });
    const dissolve = { transition: 'Cross dissolve', properties: { ...defaultProperties, transitionDuration: 1, transitionAlign: 'in' } };
    const base = { project, timeline: { id: 't', projectId: 'p', name: 'T', duration: 4 } as Timeline, nodes: [], assets: [{ asset: media('red'), path: red }, { asset: media('blue'), path: blue }],
      tracks: [{ id: 'v1', timelineId: 't', name: 'V1', number: 1, kind: 'video', muted: false, hidden: false, solo: false, locked: false, gain: 0, pan: 0 } as Track] };
    const cache = createStillCache(path.join(dir, 'frames'), renderTimeline);
    const luma = async (clips: Clip[], seconds: number) => (await run(ffmpeg, ['-v', 'error', '-i', await cache.still({ ...base, clips, settings: stillSettings(project, 4, seconds, 320).settings }), '-vf', 'scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'], { binary: true }))[0];
    // Real handles on both sides, cut at 2 s, window 2-3 s. A one-frame range used to drop the window's only frame.
    const cut = [clip('a', 'red', 0), clip('b', 'blue', 2, dissolve)];
    const before = await luma(cut, 1.5), after = await luma(cut, 3.5), middle = await luma(cut, 2.5);
    assert.ok(middle > Math.min(before, after) + 3 && middle < Math.max(before, after) - 3, `mid-dissolve is between ${before} and ${after}, saw ${middle}`);
    const frozen = [clip('a', 'red', 0), clip('b', 'blue', 2, { ...dissolve, properties: { ...dissolve.properties, freeze: true } })];
    const held = await luma(frozen, 2.5);
    assert.ok(held > Math.min(before, after) + 3 && held < Math.max(before, after) - 3, `a frozen side blends too, saw ${held}`);
    // No handles on either clip: A ends on its media's last frame and holds it through the window. A range starting
    // past that frame decoded nothing to hold, and the still showed only B.
    const unhandled = [clip('a', 'red', 0, { sourceIn: 2 }), clip('b', 'blue', 2, { ...dissolve, sourceIn: 0 })];
    const holding = await luma(unhandled, 2.5);
    assert.ok(holding > Math.min(before, after) + 3 && holding < Math.max(before, after) - 3, `a held outgoing frame blends too, saw ${holding}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a viewer who left before its frame was ready holds no file open, and the server goes on serving', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-frames-')), file = path.join(dir, `held-${process.pid}.jpg`);
  await writeFile(file, Buffer.alloc(1024 ** 2, 1));
  let arrived!: () => void, gone!: () => void, finish!: () => void;
  const asked = new Promise<void>(resolve => { arrived = resolve; }), left = new Promise<void>(resolve => { gone = resolve; }), rendered = new Promise<void>(resolve => { finish = resolve; });
  // The shared render outlives one of its viewers: its handler only reaches streamFile after that viewer's 'close'.
  const server = createServer(async (req, res) => { if (req.url === '/slow') { res.on('close', gone); arrived(); await rendered; } streamFile(req, res, file, 'image/jpeg'); });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`, controller = new AbortController();
    const abandoned = fetch(`${base}/slow`, { signal: controller.signal }).catch(() => {});
    await asked; controller.abort(); await abandoned; await left;
    finish(); await new Promise(resolve => setTimeout(resolve, 200));
    // lsof: macOS and Linux. Windows has none, and no fd to count the same way.
    let open: string | undefined; try { open = execFileSync('lsof', ['-Fn', '-p', String(process.pid)], { encoding: 'utf8' }); } catch { /* No lsof here. */ }
    if (open !== undefined) assert.ok(!open.includes(path.basename(file)), 'the file is not left open');
    const served = await fetch(`${base}/fast`);
    assert.equal(served.status, 200);
    assert.equal((await served.arrayBuffer()).byteLength, 1024 ** 2);
  } finally { server.close(); await rm(dir, { recursive: true, force: true }); }
});
