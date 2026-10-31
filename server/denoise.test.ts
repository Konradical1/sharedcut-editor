// Noise Reduction's server half against the stand-in worker in denoise.fixture.ts (node, no torch), so these tests check
// what the server asks for, not the denoising.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { bakesWholeClips, denoisesPicture, probeMedia, renderTimeline, run, type RenderRequest } from './media.ts';
import { denoiseBake, denoiseCapabilities, denoisePixfmt, denoiseService, denoiseSettingsOf } from './denoise.ts';
import { gpuJob } from './workQueue.ts';
import { denoiseChunkFrames, denoiseChunkOf, denoiseClipChunks, denoiseFrameAt } from '../src/services/denoise.ts';
import { STILL_LIVE } from './previewCache.ts';
import { useDenoiseStandIn } from './denoise.fixture.ts';
import type { Clip, MediaAsset, Project, Track } from '../src/state/models.ts';
import { defaultProperties } from '../src/state/demo.ts';

const exec = promisify(execFile), ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const track: Track = { id: 'v1', timelineId: 'timeline', number: 1, kind: 'video', name: 'V1', muted: false, solo: false, hidden: false, locked: false, gain: 0, pan: 0 };
const settings = { amount: 50, chroma: 60, frames: 2, spatial: 50, detail: 30 };
const probe = async (file: string) => JSON.parse((await exec(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,pix_fmt,color_range,color_space,color_primaries,color_transfer,nb_read_frames,codec_name', '-of', 'json', file])).stdout).streams[0];
const until = async (check: () => Promise<boolean> | boolean, ms = 20000) => { for (const end = Date.now() + ms; !await check();) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 50)); } };

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'frameline-denoise-'));
  useDenoiseStandIn(dir);
  return dir;
}
const jobsRun = (dir: string) => existsSync(path.join(dir, 'jobs.log')) ? readFileSync(path.join(dir, 'jobs.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];

test('chunk math, settings and pixel formats', () => {
  // Every frame of a 59.94 source lands in exactly one chunk, and the chunk of a frame's own time holds it.
  const fps = 60000 / 1001, duration = 9.5, total = Math.round(duration * fps);
  let next = 0;
  for (let chunk = 0; ; chunk++) { const { first, frames } = denoiseChunkFrames(chunk, fps, duration); if (!frames) break; assert.ok(first === next, `chunk ${chunk} starts at ${first}`); next += frames; }
  assert.equal(next, total);
  for (const i of [0, 119, 120, 121, 500]) assert.equal(denoiseChunkOf(i / fps, fps), Math.floor(i / (2 * fps) + 1e-9));
  assert.equal(denoiseFrameAt(1.5 / 24, 24), 1, 'a tie between two frames takes the earlier one');
  // Denoise all asks for the chunks a clip shows: its source span at its speed, one for a freeze, never past the source.
  const shows = (sourceIn: number, length: number, properties: Record<string, unknown> = {}) => denoiseClipChunks({ sourceIn, duration: length, properties } as never, { fps: 24, duration: 9 });
  assert.deepEqual(shows(0, 2), [0]); assert.deepEqual(shows(1, 2), [0, 1]); assert.deepEqual(shows(3, 2, { speed: 200 }), [1, 2, 3]);
  assert.deepEqual(shows(5, 4, { freeze: true }), [2]); assert.deepEqual(shows(0, 30), [0, 1, 2, 3, 4]);
  assert.deepEqual(['yuv420p', 'p010le', 'yuvj420p', 'yuv422p10le', 'v210', 'yuv444p12le', 'gbrp10le', 'yuva444p10le'].map(denoisePixfmt), ['yuv420p16le', 'yuv420p16le', 'yuv420p16le', 'yuv422p16le', 'yuv422p16le', 'yuv444p16le', 'yuv444p16le', 'yuv444p16le']);
  assert.deepEqual(denoiseSettingsOf({ ...settings, amount: 50.0000004 }), settings);
  assert.throws(() => denoiseSettingsOf({ ...settings, frames: 1.5 }), /Frames must be between 0 and 3/);
  assert.throws(() => denoiseSettingsOf({ ...settings, amount: 101 }), /Strength/);
  assert.throws(() => denoiseSettingsOf(undefined), /missing/);
});

test('a missing worker is reported with its setup command', async () => {
  process.env.FRAME_LINE_DENOISE_WORKER = path.join(tmpdir(), 'no-such-denoise.py');
  assert.match((await denoiseCapabilities()).reason ?? '', /npm run setup:denoise/);
});

test('preview chunks: proxy size and encode per quality, cache hits, stale generations, the queue cap and idle stop', { timeout: 120000 }, async () => {
  const dir = await setup(), service = denoiseService(path.join(dir, 'data'));
  try {
    const source = path.join(dir, 'source.mov');
    // 4:2:2 10-bit at 1280×720, 3 s at 24 fps: chunk 0 is 48 frames, chunk 1 the remaining 24.
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=24:d=3', '-vf', 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', source]);
    const asset = { id: 'a', kind: 'video', fps: 24, frameRate: '24/1', duration: 3, colorMatrix: 'bt709', colorRange: 'tv' } as MediaAsset;
    const ask = (chunk: number, quality: string, view: 'denoised' | 'noise' = 'denoised', s = settings, clipId = 'c') => service.preview({ projectId: 'p', clipId, input: source, asset, chunk, quality, view, settings: s });
    const ready = async (chunk: number, quality: string, view: 'denoised' | 'noise' = 'denoised') => { let r = await ask(chunk, quality, view); await until(async () => (r = await ask(chunk, quality, view)).status !== 'preparing'); assert.equal(r.status, 'ready', r.error); return r; };
    const full = await ready(0, 'Full');
    assert.match(full.url!, /^\/api\/denoise\/[a-f0-9]{64}\/files\/video\.mp4\?projectId=p$/);
    assert.deepEqual(JSON.parse(JSON.stringify([full.from, full.duration, full.fps])), [0, 2, 24]);
    const file = service.chunk('p', full.key);
    assert.deepEqual(await probe(file), { codec_name: 'h264', width: 1280, height: 720, pix_fmt: 'yuv422p10le', color_range: 'tv', color_space: 'bt709', nb_read_frames: '48' });
    const job = jobsRun(dir)[0];
    assert.equal(job.pixfmt, 'yuv422p16le'); assert.deepEqual([job.first, job.frames, job.width, job.height], [0, 48, 1280, 720]);
    assert.deepEqual(job.colors, { range: 'tv', matrix: 'bt709', primaries: 'bt709', transfer: 'bt709' });
    assert.ok(job.encode.includes('-crf') && job.encode[job.encode.indexOf('-crf') + 1] === '17', 'full-v3 recipe');
    assert.ok(existsSync(job.profile), 'the profile is written once and kept');
    // Stream and 1/4 are the stream-v2 and stream-low-v2 sizes and encodes; Color and Original play full-v3, so they share Full's chunk.
    const stream = await ready(1, 'Stream'), low = await ready(1, '1/4');
    assert.deepEqual(await probe(service.chunk('p', stream.key)), { codec_name: 'h264', width: 960, height: 540, pix_fmt: 'yuv420p', color_range: 'tv', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709', nb_read_frames: '24' });
    assert.equal((await probe(service.chunk('p', low.key))).width, 480);
    assert.equal(stream.from, 2);
    const before = jobsRun(dir).length;
    assert.equal((await ask(0, 'Color')).status, 'ready'); assert.equal((await ask(0, 'Original')).key, full.key);
    assert.equal(jobsRun(dir).length, before, 'a cache hit runs nothing');
    assert.notEqual((await ready(0, 'Full', 'noise')).key, full.key, 'the removed-noise view is its own chunk');
    assert.throws(() => service.chunk('other', full.key), /not found/);
    await assert.rejects(ask(9, 'Full'), /Invalid preview chunk/);
    await assert.rejects(ask(0, 'Huge'), /Invalid preview quality/);
    // A held worker: a new setting aborts the clip's stale chunk, other clips keep theirs, and eight preparing jobs fill the queue.
    writeFileSync(path.join(dir, 'slow'), '');
    const stale = await ask(0, 'Full', 'denoised', { ...settings, amount: 20 });
    await until(() => jobsRun(dir).some(j => j.settings.amount === 20));
    const fresh = await ask(0, 'Full', 'denoised', { ...settings, amount: 21 });
    for (let i = 0; i < 7; i++) await ask(0, '1/2', 'denoised', { ...settings, amount: 30 + i }, `other-${i}`);
    await assert.rejects(ask(0, '1/2', 'denoised', { ...settings, amount: 40 }, 'one-too-many'), /queue is full/);
    await until(() => existsSync(path.join(dir, 'cancel.log')));
    rmSync(path.join(dir, 'slow'));
    await until(async () => (await ask(0, 'Full', 'denoised', { ...settings, amount: 21 })).status === 'ready');
    for (let i = 0; i < 7; i++) await until(async () => (await ask(0, '1/2', 'denoised', { ...settings, amount: 30 + i }, `other-${i}`)).status === 'ready');
    assert.throws(() => service.chunk('p', stale.key), /not found/, 'the stale chunk was never finished');
    // Two viewers of one clip at different qualities share its settings: neither cancels the other's chunk.
    writeFileSync(path.join(dir, 'slow'), '');
    const cancels = () => existsSync(path.join(dir, 'cancel.log')) ? readFileSync(path.join(dir, 'cancel.log'), 'utf8').trim().split('\n').length : 0, cancelled = cancels();
    await ask(0, 'Full', 'denoised', { ...settings, amount: 60 });
    await until(() => jobsRun(dir).some(j => j.settings.amount === 60));
    for (let i = 0; i < 3; i++) { await ask(0, 'Stream', 'denoised', { ...settings, amount: 60 }); await ask(0, 'Full', 'noise', { ...settings, amount: 60 }); await ask(0, 'Full', 'denoised', { ...settings, amount: 60 }); }
    assert.equal(cancels(), cancelled, 'nothing was cancelled');
    rmSync(path.join(dir, 'slow'));
    for (const [quality, view] of [['Full', 'denoised'], ['Stream', 'denoised'], ['Full', 'noise']] as const) await until(async () => (await ask(0, quality, view, { ...settings, amount: 60 })).status === 'ready');
    // A finished chunk outlives a cancel (another viewer may play it); one the trim took is prepared again, not reported ready.
    service.cancel('p', full.key);
    const kept = service.chunk('p', full.key);
    rmSync(kept);
    assert.equal((await ask(0, 'Full')).status, 'preparing');
    assert.equal((await ready(0, 'Full')).key, full.key);
    // Freeing the GPU stops an idle worker; the next chunk starts a new one.
    assert.equal(readFileSync(path.join(dir, 'serve.log'), 'utf8').split('\n').length - 1, 1, 'one resident worker served every chunk');
    service.stopIdle();
    await ready(1, 'Full');
    assert.equal(readFileSync(path.join(dir, 'serve.log'), 'utf8').split('\n').length - 1, 2);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Denoise all prepares every chunk of each clip in turn, reports per-clip progress and stops on request', { timeout: 120000 }, async () => {
  const dir = await setup(), service = denoiseService(path.join(dir, 'data'));
  try {
    const source = path.join(dir, 'source.mov');
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=5', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', source]);
    const asset = { id: 'a', kind: 'video', fps: 24, frameRate: '24/1', duration: 5, colorMatrix: 'bt709', colorRange: 'tv' } as MediaAsset;
    const item = (clipId: string, chunks: number[]) => ({ clipId, input: source, asset, settings, chunks });
    assert.equal(service.allStatus('p').status, 'none');
    service.all({ projectId: 'p', timelineId: 't', quality: '1/4', clips: [item('one', [0, 1]), item('two', [2])] });
    await until(() => service.allStatus('p').status === 'done');
    assert.deepEqual(service.allStatus('p').clips, { one: { done: 2, total: 2 }, two: { done: 1, total: 1 } });
    assert.deepEqual(service.resumable(), [], 'a finished run is not resumed');
    // Its chunks are the viewer's: asking for one again is a cache hit.
    assert.equal((await service.preview({ projectId: 'p', clipId: 'one', input: source, asset, chunk: 1, quality: '1/4', view: 'denoised', settings })).status, 'ready');
    // Stop: the held chunk is cancelled, the clip never finishes, and the run says stopped.
    writeFileSync(path.join(dir, 'slow'), '');
    const before = jobsRun(dir).length;
    service.all({ projectId: 'p', timelineId: 't', quality: 'Stream', clips: [item('one', [0, 1])] });
    await until(() => jobsRun(dir).length > before);
    // A server restarting now (a deploy) finds the run to start again.
    assert.deepEqual(denoiseService(path.join(dir, 'data')).resumable(), [{ projectId: 'p', timelineId: 't', quality: 'Stream' }]);
    service.stopAll('p');
    assert.deepEqual(service.resumable(), [], 'a run stopped on request is not resumed');
    rmSync(path.join(dir, 'slow'));
    assert.equal(service.allStatus('p').status, 'stopped');
    assert.deepEqual(service.allStatus('p').clips.one, { done: 0, total: 2 });
    assert.throws(() => service.all({ projectId: 'p', timelineId: 't', quality: 'Huge', clips: [] }), /Invalid preview quality/);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('export bakes the original before the grade, keeps its sound and colour tags, reuses the bake and refuses what it cannot bake', { timeout: 120000 }, async () => {
  const dir = await setup();
  try {
    const source = path.join(dir, 'source.mp4');
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-vf', 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source]);
    const asset: MediaAsset = { id: 'asset', projectId: 'project', name: 'source.mp4', kind: 'video', binId: 'all', duration: 3, fps: 24, frameRate: '24/1', resolution: '320 × 180', size: '10 KB', status: 'ready', progress: 100, thumbnail: '', hasAudio: true, colorRange: 'tv', colorMatrix: 'bt709' };
    const effect = { id: 'nr', name: 'Noise Reduction', enabled: true, amount: 50, parameters: { frames: 1 } };
    const clip: Clip = { id: 'clip', projectId: 'project', timelineId: 'timeline', mediaId: 'asset', name: 'Grainy', trackId: 'v1', start: 0, duration: 2, sourceIn: .5, color: 'red', disabled: false, properties: { ...defaultProperties }, effects: [{ id: 'eq', name: 'EQ', enabled: true, amount: 100 }, effect] };
    const request: RenderRequest = { project: { id: 'project', resolution: '320 × 180', fps: 24 } as Project, timeline: { id: 'timeline', projectId: 'project', name: 'test', duration: 2 }, tracks: [track], clips: [clip], nodes: [], assets: [{ asset, path: source }],
      settings: { resolution: '320 × 180', fps: '24', rangeIn: '0', rangeOut: '2', audio: 'AAC · 320 kb/s · 48 kHz' }, outputPath: path.join(dir, 'out.mp4'), denoiseDir: path.join(dir, 'denoise') };
    assert.ok(bakesWholeClips(request), 'previews and stills leave it to the editor');
    assert.ok(!bakesWholeClips({ ...request, tracks: [{ ...track, kind: 'audio' }] }), 'on an audio track it shapes nothing');
    assert.match(STILL_LIVE.denoise, /Noise Reduction/);
    const progress: number[] = [];
    await renderTimeline({ ...request, onProgress: value => progress.push(value) });
    const output = await probeMedia(request.outputPath);
    assert.ok(Math.abs(output.duration - 2) < .1, `duration ${output.duration}`);
    assert.ok(output.hasAudio, 'the original carries the sound');
    assert.ok(progress.some(value => value > 0 && value < 45) && progress.at(-1)! >= 99, 'progress spans bake and composite');
    const [job] = jobsRun(dir);
    // sourceIn .5 at 24 fps is frame 12; two seconds of clip read 48 frames.
    assert.deepEqual([job.first, job.frames, job.width, job.height, job.pixfmt, job.view], [12, 48, 320, 180, 'yuv420p16le', 'denoised']);
    assert.deepEqual(job.settings, { amount: 50, chroma: 60, frames: 1, spatial: 50, detail: 30 });
    assert.deepEqual(job.encode.slice(0, 8), ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le']);
    const bakes = readdirSync(path.join(dir, 'denoise', 'exports')).filter(name => name.endsWith('.mov'));
    assert.equal(bakes.length, 1);
    const bake = await probe(path.join(dir, 'denoise', 'exports', bakes[0]));
    assert.deepEqual([bake.codec_name, bake.pix_fmt, bake.color_space, bake.color_primaries, bake.color_transfer, bake.nb_read_frames], ['prores', 'yuv422p10le', 'bt709', 'bt709', 'bt709', '48']);
    // The picture is the source's own frames (the stand-in passes them through) at the same place: frame 12 of the source.
    const frame = async (file: string, seconds: number) => run(ffmpeg, ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'scale=32:18', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { binary: true });
    const [a, b] = [await frame(request.outputPath, 0), await frame(source, .5)];
    assert.ok(a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length < 6, 'the bake starts where the clip does');
    await renderTimeline({ ...request, outputPath: path.join(dir, 'again.mp4') });
    assert.equal(jobsRun(dir).length, 1, 'a re-export reuses the bake');
    // A full-range source: a MOV reads back as video range whatever it holds, so the bake converts into it explicitly.
    const full = path.join(dir, 'full.mp4');
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=3', '-vf', 'scale=out_range=pc,setparams=range=pc:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'pc', full]);
    await renderTimeline({ ...request, assets: [{ asset: { ...asset, colorRange: 'pc', hasAudio: false }, path: full }], outputPath: path.join(dir, 'full-out.mp4') });
    assert.deepEqual(jobsRun(dir)[1].encode.slice(0, 4), ['-vf', 'scale=in_range=pc:out_range=tv', '-color_range', 'tv']);
    const fullBake = path.join(dir, 'denoise', 'exports', readdirSync(path.join(dir, 'denoise', 'exports')).find(name => name.endsWith('.mov') && name !== bakes[0])!);
    const luma = new Uint16Array((await run(ffmpeg, ['-v', 'error', '-i', fullBake, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv422p10le', '-'], { binary: true })).buffer.slice(0, 320 * 180 * 2));
    assert.deepEqual([(await probe(fullBake)).color_range, Math.min(...luma) >= 60, Math.max(...luma) <= 944], ['tv', true, true], `luma ${Math.min(...luma)}–${Math.max(...luma)}`);
    await assert.rejects(renderTimeline({ ...request, clips: [{ ...clip, keyframes: { 'effects.nr.parameters.chroma': [{ id: 'k', time: 0, value: 10, interpolation: 'linear' }] } }] }), /cannot be keyframed/);
    await assert.rejects(renderTimeline({ ...request, assets: [{ asset: { ...asset, hasAlpha: true }, path: source }] }), /transparency/);
    const worker = process.env.FRAME_LINE_DENOISE_WORKER!;
    process.env.FRAME_LINE_DENOISE_WORKER = path.join(dir, 'missing.py');
    await assert.rejects(renderTimeline({ ...request, clips: [{ ...clip, effects: [{ ...effect, parameters: { frames: 3 } }] }] }), /Grainy: Noise Reduction needs the denoise worker on this server\. Run npm run setup:denoise\./);
    // Outside the range, on a hidden track or on a still the effect is only dropped: nothing to bake. Titles, shapes,
    // adjustment layers and compositions never bake it.
    process.env.FRAME_LINE_DENOISE_WORKER = worker;
    const baked = jobsRun(dir).length;
    await renderTimeline({ ...request, clips: [{ ...clip, start: 5 }], timeline: { ...request.timeline, duration: 7 }, outputPath: path.join(dir, 'outside.mp4') });
    await renderTimeline({ ...request, tracks: [{ ...track, hidden: true }], outputPath: path.join(dir, 'hidden.mp4') });
    const still = path.join(dir, 'still.png');
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180', '-frames:v', '1', still]);
    await renderTimeline({ ...request, assets: [{ asset: { ...asset, kind: 'image', hasAudio: false, fps: 0 }, path: still }], outputPath: path.join(dir, 'still.mp4') });
    assert.equal(jobsRun(dir).length, baked);
    for (const other of [{ mediaId: 'frameline-title' }, { mediaId: 'frameline-adjustment' }, { mediaId: 'frameline-composition', properties: { ...defaultProperties, compositionId: 't2' } }]) assert.ok(!denoisesPicture(request, { ...clip, ...other }), other.mediaId);
    // A key on a setting no panel shows any more (an older build's) does not block the export.
    await renderTimeline({ ...request, clips: [{ ...clip, keyframes: { 'effects.nr.parameters.temporal': [{ id: 'k', time: 0, value: 10, interpolation: 'linear' }] } }], outputPath: path.join(dir, 'legacy-key.mp4') });
    assert.equal(jobsRun(dir).length, baked, 'the same bake');
    // An In/Out range inside the clip bakes only that, not the whole clip: source 1.5-2.0 s is frames 36-47.
    await renderTimeline({ ...request, settings: { ...request.settings, rangeIn: '1', rangeOut: '1.5' }, outputPath: path.join(dir, 'range.mp4') });
    assert.deepEqual([jobsRun(dir).at(-1).first, jobsRun(dir).at(-1).frames], [36, 12]);
    assert.ok(Math.abs((await probeMedia(path.join(dir, 'range.mp4'))).duration - .5) < .1);
    // A 30 fps source on a 24 fps timeline trimmed between source frames (sourceIn 0.125 s is frame 3.75): the bake starts at
    // frame 3, at or before the clip, so its remapped sourceIn is never negative.
    const thirty = path.join(dir, 'thirty.mp4');
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-vf', 'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', thirty]);
    await renderTimeline({ ...request, assets: [{ asset: { ...asset, fps: 30, frameRate: '30/1', hasAudio: false }, path: thirty }], clips: [{ ...clip, sourceIn: .125 }], outputPath: path.join(dir, 'thirty-out.mp4') });
    assert.equal(jobsRun(dir).at(-1).first, 3);
    // Data levels: an override says what the planes hold. Full on a full-range source matches the export without Noise
    // Reduction (the bake is converted once, then read as video range); Video on a source mis-tagged pc is only retagged.
    const levelled = { ...clip, properties: { ...clip.properties, dataLevels: 'Full' } }, fullAsset = { ...asset, colorRange: 'pc', hasAudio: false };
    await renderTimeline({ ...request, assets: [{ asset: fullAsset, path: full }], clips: [levelled], outputPath: path.join(dir, 'levels-nr.mp4') });
    await renderTimeline({ ...request, assets: [{ asset: fullAsset, path: full }], clips: [{ ...levelled, effects: [] }], outputPath: path.join(dir, 'levels-plain.mp4') });
    const [withNr, without] = [await frame(path.join(dir, 'levels-nr.mp4'), 0), await frame(path.join(dir, 'levels-plain.mp4'), 0)];
    assert.ok(withNr.reduce((sum, v, i) => sum + Math.abs(v - without[i]), 0) / withNr.length < 3, 'Full levels read the same with and without Noise Reduction');
    await renderTimeline({ ...request, assets: [{ asset: fullAsset, path: full }], clips: [{ ...clip, properties: { ...clip.properties, dataLevels: 'Video' } }], outputPath: path.join(dir, 'levels-video.mp4') });
    assert.deepEqual([jobsRun(dir).at(-1).colors.range, ...jobsRun(dir).at(-1).encode.slice(0, 3)], ['tv', '-color_range', 'tv', '-c:v']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Original quality on HDR footage plays the camera original: its chunk is not tone-mapped and keeps the source tags', { timeout: 120000 }, async () => {
  const dir = await setup(), service = denoiseService(path.join(dir, 'data'));
  try {
    const source = path.join(dir, 'hlg.mov');
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1', '-vf', 'setparams=range=tv:color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', source]);
    const asset = { id: 'h', kind: 'video', fps: 24, frameRate: '24/1', duration: 1, colorMatrix: 'bt2020nc', colorRange: 'tv', colorTransfer: 'arib-std-b67' } as MediaAsset;
    const ask = (quality: string) => service.preview({ projectId: 'p', clipId: 'c', input: source, asset, chunk: 0, quality, view: 'denoised', settings });
    for (const quality of ['Original', 'Full']) await until(async () => (await ask(quality)).status === 'ready');
    const [original, full] = jobsRun(dir).map(job => job.encode[job.encode.indexOf('-vf') + 1] as string);
    assert.ok(!original.includes('lut3d') && original.endsWith(',setparams=color_primaries=bt2020:color_trc=arib-std-b67'), original);
    assert.ok(full.includes('lut3d'), 'Full is the tone-mapped proxy recipe');
    const tags = await probe(service.chunk('p', (await ask('Original')).key));
    assert.deepEqual([tags.color_primaries, tags.color_transfer], ['bt2020', 'arib-std-b67']);
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a worker that never starts gives the GPU back as soon as its chunk is cancelled', { timeout: 60000 }, async () => {
  const dir = await setup(), service = denoiseService(path.join(dir, 'data'));
  try {
    writeFileSync(path.join(dir, 'hang'), '');
    const source = path.join(dir, 'source.mp4');
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
    const asset = { id: 'a', kind: 'video', fps: 24, frameRate: '24/1', duration: 1, colorMatrix: 'bt709', colorRange: 'tv' } as MediaAsset;
    const chunk = await service.preview({ projectId: 'p', clipId: 'c', input: source, asset, chunk: 0, quality: '1/4', view: 'denoised', settings });
    await until(() => existsSync(path.join(dir, 'serve.log')));
    service.cancel('p', chunk.key);
    const started = Date.now();
    assert.equal(await gpuJob(async () => 'ran'), 'ran');
    assert.ok(Date.now() - started < 5000, 'the GPU queue moved on');
  } finally { await service.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a bake short of disk frees old bakes first, oldest first, never one a running export reads', async () => {
  const dir = await setup(), exports = path.join(dir, 'exports'), saved = process.env.FRAME_LINE_MIN_FREE_GB;
  try {
    const source = path.join(dir, 'source.mp4');
    await exec(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
    mkdirSync(path.join(exports, '.denoise-left'), { recursive: true });
    for (const name of ['a'.repeat(64) + '.mov', 'b'.repeat(64) + '.mov']) writeFileSync(path.join(exports, name), 'bake');
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(path.join(exports, '.denoise-left'), old, old);
    // No disk is big enough for this floor: everything that may go goes, and the bake is still refused.
    process.env.FRAME_LINE_MIN_FREE_GB = '1000000';
    await assert.rejects(denoiseBake({ name: 'Grainy', input: source, directory: exports, profiles: path.join(dir, 'profiles'), range: { from: 0, to: 1 }, fps: 24, duration: 1, settings, keep: new Set(['b'.repeat(64)]) }), /not enough disk space/);
    assert.deepEqual(readdirSync(exports).sort(), ['b'.repeat(64) + '.mov']);
  } finally { if (saved === undefined) delete process.env.FRAME_LINE_MIN_FREE_GB; else process.env.FRAME_LINE_MIN_FREE_GB = saved; await rm(dir, { recursive: true, force: true }); }
});
