import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { byteRange, moovExtent, parseMp4Index } from './mp4Index.ts';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
const available = spawnSync(ffmpeg, ['-version']).status === 0;

test('sample offsets match ffprobe and a range starts on the previous keyframe', { skip: !available && 'ffmpeg unavailable' }, () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mp4index-')), 'tiny.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x36:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', file]);
  const bytes = readFileSync(file), head = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const index = parseMp4Index(head)!;
  assert.ok(index && index.tracks.length === 2, 'video and audio tracks parsed');
  assert.equal(moovExtent(head.slice(0, 64)), index.moovEnd, 'the moov header alone tells how much head to fetch');
  assert.equal(parseMp4Index(head.slice(0, 64)), null, 'a head that stops inside moov is incomplete');
  assert.ok(index.moovEnd < 40000 && index.moovEnd > 100);

  const packets = execFileSync(ffprobe, ['-v', 'error', '-show_packets', '-show_entries', 'packet=stream_index,pos,size,flags', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim().split('\n').map(line => { const [stream, size, pos, flags] = line.split(','); return { stream: Number(stream), pos: Number(pos), size: Number(size), key: flags.startsWith('K') }; });
  const known = new Set(index.tracks.flatMap(track => Array.from(track.offsets, (offset, i) => `${offset}:${track.sizes[i]}`)));
  for (const packet of packets) assert.ok(known.has(`${packet.pos}:${packet.size}`), `packet at ${packet.pos} (${packet.size} bytes) is in the index`);

  // 24 fps, GOP 12: keyframes at 0, .5, 1.0, 1.5 … A request for 1.1–1.3 s must begin at the 1.0 s keyframe.
  const video = index.tracks.find(track => track.sync)!;
  const keyAt1 = video.sync!.find(sample => Math.abs(video.times[sample] - 1) < 1e-6)!;
  const range = byteRange(index, 1.1, 1.3)!;
  assert.ok(range.start <= video.offsets[keyAt1], 'range begins no later than the 1.0 s keyframe');
  assert.ok(range.start > video.offsets[video.sync![0]], 'range does not fall back to the first keyframe');
  const lastNeeded = Array.from(video.times).findIndex(time => time >= 1.3);
  assert.ok(range.end >= video.offsets[lastNeeded] + video.sizes[lastNeeded], 'range reaches the frame shown at 1.3 s');
  assert.ok(range.end < bytes.byteLength, 'range does not swallow the whole file');
  assert.equal(byteRange({ moovEnd: 0, tracks: [] }, 0, 1), null);
});
