import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { probeMedia, renderTimeline } from '../server/media.ts';
import { defaultProperties } from '../src/state/demo.ts';

const source = process.argv[2], count = Number(process.argv[3] ?? 128);
if (!source || !Number.isInteger(count) || count < 2 || count % 2) throw new Error('Usage: render-stress.mjs SOURCE TOTAL_CLIPS (an even number)');

const metadata = await probeMedia(source), fps = metadata.fps || 24, frame = 1 / fps, shots = count / 2;
const project = { id: 'stress', name: 'Stress', resolution: '3840 × 2160', fps, duration: shots * frame };
const timeline = { id: 'timeline', projectId: project.id, name: 'Stress', duration: shots * frame };
const asset = { id: 'source', projectId: project.id, name: path.basename(source), kind: 'video', binId: 'all', thumbnail: '', duration: metadata.duration, resolution: metadata.resolution, fps, size: String(metadata.size), status: 'ready', progress: 100, hasAudio: metadata.hasAudio, inputProfile: metadata.inputProfile, inputGamut: metadata.inputGamut, colorRange: metadata.colorRange, colorMatrix: metadata.colorMatrix };
const video = { id: 'video', timelineId: timeline.id, name: 'Video', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 };
const audio = { ...video, id: 'audio', name: 'Audio', kind: 'audio', number: 1 };
const clips = Array.from({ length: shots }, (_, index) => {
  const start = index * frame, sourceIn = index % Math.max(1, Math.floor(metadata.duration - frame));
  const base = { projectId: project.id, timelineId: timeline.id, mediaId: asset.id, name: `Shot ${index + 1}`, start, duration: frame, sourceIn, color: '#668b9e', disabled: false, effects: [] };
  const linkGroup = `link-${index}`;
  return [
    { ...base, id: `v-${index}`, trackId: video.id, properties: { ...defaultProperties, audioDetached: true, linkGroup } },
    { ...base, id: `a-${index}`, trackId: audio.id, properties: { ...defaultProperties, linkGroup } },
  ];
}).flat();

const exec = promisify(execFile), started = performance.now(), directory = await mkdtemp(path.join(tmpdir(), 'frameline-stress-'));
let peakRSSKB = 0, sampling = false;
const timer = setInterval(async () => {
  if (sampling) return;
  sampling = true;
  try {
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=']);
    const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const descendants = new Set([process.pid]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [pid, ppid] of rows) if (descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); changed = true; }
    }
    peakRSSKB = Math.max(peakRSSKB, rows.filter(([pid]) => descendants.has(pid)).reduce((sum, row) => sum + row[2], 0));
  } finally { sampling = false; }
}, 100);

try {
  const outputPath = path.join(directory, 'stress.mp4');
  await renderTimeline({ project, timeline, tracks: [video, audio], clips, nodes: [], assets: [{ asset, path: source }], settings: { resolution: project.resolution, fps: String(fps), codec: 'H.264', quality: 'Automatic', rangeIn: '0', rangeOut: String(timeline.duration), audio: 'AAC · 192 kb/s · 48 kHz' }, outputPath });
  console.log(JSON.stringify({ clips: count, shots, seconds: Number(((performance.now() - started) / 1000).toFixed(2)), peakRSSMB: Math.round(peakRSSKB / 1024), output: await probeMedia(outputPath) }));
} finally {
  clearInterval(timer);
  await rm(directory, { recursive: true, force: true });
}
