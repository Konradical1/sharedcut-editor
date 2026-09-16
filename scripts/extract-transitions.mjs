#!/usr/bin/env node
// Cut a compilation reel of light leaks / film burns into one clip per leak.
//
// Each leak in these reels starts and ends on black, so black runs are the segment boundaries.
// Two of the three supplied reels flicker through black *inside* a burn, which naive detection
// splits into fragments, so short black runs are treated as part of the leak rather than a
// boundary. Both thresholds stay as flags: these are real recordings and the numbers need
// tuning per reel.
//
//   node scripts/extract-transitions.mjs --out data/transitions "reel.mp4" ...
//   node scripts/extract-transitions.mjs --report            # contact sheets only, no cuts
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let out = '', err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(command)} exited ${code}\n${err.slice(-2000)}`)));
  });
}

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const has = name => process.argv.includes(`--${name}`);

const minGap = Number(flag('min-gap', .30));        // black shorter than this does not split a leak
const minDuration = Number(flag('min-duration', .40)); // a leak shorter than this is a flicker, not a transition
const maxDuration = Number(flag('max-duration', 4));   // longer runs are title cards, not leaks
const pixelThreshold = flag('pixel-threshold', '0.12');
const pictureThreshold = flag('picture-threshold', '0.97');
const outDir = path.resolve(flag('out', 'data/transitions'));
// One supplied reel carries a burned-in watermark strip along the bottom. Screen blending shows
// every non-black pixel, so the strip is cropped away and the frame rescaled rather than masked:
// a mask leaves a hard edge where the grain stops, a crop leaves nothing.
const cropBottom = Number(flag('crop-bottom', 0));
const cropSource = flag('crop-source', '');

async function detectBlack(file) {
  const { err } = await run(ffmpeg, ['-hide_banner', '-nostdin', '-i', file,
    '-vf', `blackdetect=d=0.04:pic_th=${pictureThreshold}:pix_th=${pixelThreshold}`, '-an', '-f', 'null', '-']);
  return [...err.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(match => ({ start: Number(match[1]), end: Number(match[2]) }));
}

async function probe(file) {
  const { out } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type,r_frame_rate', '-of', 'json', file]);
  const data = JSON.parse(out);
  const video = data.streams.find(stream => stream.codec_type === 'video');
  const [num, den] = (video?.r_frame_rate || '24/1').split('/').map(Number);
  return { duration: Number(data.format.duration), fps: num / (den || 1), hasAudio: data.streams.some(stream => stream.codec_type === 'audio') };
}

/** Black runs become boundaries; runs shorter than minGap are absorbed into the surrounding leak. */
function segments(black, duration) {
  const boundaries = black.filter(run => run.end - run.start >= minGap);
  const result = [];
  let cursor = 0;
  for (const run of boundaries) {
    if (run.start > cursor) result.push({ start: cursor, end: run.start, before: cursor, after: run });
    cursor = run.end;
  }
  if (duration > cursor) result.push({ start: cursor, end: duration, before: cursor, after: null });
  return result
    .map((segment, index) => {
      // Begin and end a little way inside the surrounding black so the leak fades from nothing.
      const previous = boundaries.filter(run => run.end <= segment.start + 1e-6).at(-1);
      const lead = previous ? Math.min(.15, (previous.end - previous.start) / 2) : 0;
      const tail = segment.after ? Math.min(.15, (segment.after.end - segment.after.start) / 2) : 0;
      return { index, start: Math.max(0, segment.start - lead), end: Math.min(duration, segment.end + tail) };
    })
    .filter(segment => segment.end - segment.start >= minDuration && segment.end - segment.start <= maxDuration);
}

/** Mean luma over the segment, so a nearly-black false positive can be culled from the manifest. */
async function brightness(file, start, end) {
  // metadata=print writes to stdout, so the YAVG samples arrive there rather than on stderr.
  const { out, err } = await run(ffmpeg, ['-hide_banner', '-nostdin', '-ss', String(start), '-t', String(end - start), '-i', file,
    '-vf', 'scale=64:36,signalstats,metadata=print:file=-', '-an', '-f', 'null', '-']);
  const values = [...`${out}${err}`.matchAll(/lavfi\.signalstats\.YAVG=([\d.]+)/g)].map(match => Number(match[1]));
  const printed = values.length ? values : [0];
  const peak = Math.max(...printed);
  // The cut belongs where the overlay is fullest, so this is the brightest moment — smoothed over
  // three frames first so a single noisy frame cannot drag it off the actual burn.
  const smooth = printed.map((_, index) => {
    const window = printed.slice(Math.max(0, index - 1), index + 2);
    return window.reduce((a, b) => a + b, 0) / window.length;
  });
  const centre = smooth.indexOf(Math.max(...smooth));
  return { mean: printed.reduce((a, b) => a + b, 0) / printed.length, peak, peakAt: centre / Math.max(1, printed.length - 1) };
}

async function main() {
  const files = process.argv.slice(2).filter(argument => !argument.startsWith('--') && /\.(mp4|mov|mkv|webm)$/i.test(argument));
  if (!files.length) { console.error('Pass at least one source reel.\n  node scripts/extract-transitions.mjs "reel.mp4"'); process.exit(1); }
  await mkdir(outDir, { recursive: true });
  await mkdir(path.join(outDir, 'sheets'), { recursive: true });

  const manifestPath = path.join(outDir, 'manifest.json');
  const existing = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => ({ leaks: [] }));
  const leaks = [];
  let counter = 0;

  for (const file of files) {
    const source = path.basename(file);
    const { duration, fps, hasAudio } = await probe(file);
    const black = await detectBlack(file);
    const found = segments(black, duration);
    console.log(`\n${source}  ${duration.toFixed(1)}s @ ${fps.toFixed(2)}fps  ${black.length} black runs -> ${found.length} leaks`);

    for (const segment of found) {
      const length = segment.end - segment.start;
      const stats = await brightness(file, segment.start, segment.end);
      // A segment that never gets brighter than deep grey is a detection artefact, not a leak.
      if (stats.peak < 40) { console.log(`  skip ${source} #${segment.index + 1}  peak luma ${stats.peak.toFixed(0)} — too dark`); continue; }
      const id = `leak-${String(++counter).padStart(2, '0')}`;
      const output = path.join(outDir, `${id}.mp4`);
      const sheet = path.join(outDir, 'sheets', `${id}.png`);
      const trim = cropBottom > 0 && cropSource && source.toLowerCase().includes(cropSource.toLowerCase())
        ? `crop=iw:ih-${cropBottom}:0:0,` : '';
      if (!has('report')) {
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(segment.start), '-t', String(length), '-i', file,
          '-vf', `${trim}scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1`,
          '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
          ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000'] : ['-an']),
          '-movflags', '+faststart', output]);
      }
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(segment.start), '-t', String(length), '-i', file,
        '-vf', `${trim}fps=${(9 / length).toFixed(4)},scale=240:-1,tile=3x3`, '-frames:v', '1', sheet]);
      if (!has('report')) {
        await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(segment.start + length * stats.peakAt), '-i', file,
          '-vf', `${trim}scale=384:-1`, '-frames:v', '1', '-q:v', '4', path.join(outDir, `${id}.jpg`)]);
      }
      leaks.push({ id, name: `Leak ${String(counter).padStart(2, '0')}`, source, file: `${id}.mp4`,
        start: Number(segment.start.toFixed(3)), duration: Number(length.toFixed(3)), fps: Number(fps.toFixed(3)),
        hasAudio, meanLuma: Number(stats.mean.toFixed(1)), peakLuma: Number(stats.peak.toFixed(1)), peakAt: Number(stats.peakAt.toFixed(4)), poster: `${id}.jpg` });
      console.log(`  ${id}  ${length.toFixed(2)}s  peak luma ${stats.peak.toFixed(0)} at ${(stats.peakAt * 100).toFixed(0)}%`);
    }
  }

  if (!has('report')) {
    await writeFile(manifestPath, JSON.stringify({ version: 1, updatedAt: Date.now(), leaks }, null, 2));
    // Anything the previous run produced that this one did not is stale.
    for (const stale of (existing.leaks ?? []).filter(leak => !leaks.some(next => next.id === leak.id))) {
      await rm(path.join(outDir, stale.file), { force: true });
      await rm(path.join(outDir, `${stale.id}.jpg`), { force: true });
      await rm(path.join(outDir, 'sheets', `${stale.id}.png`), { force: true });
    }
  }
  console.log(`\n${leaks.length} leaks -> ${outDir}`);
  console.log(`Review ${path.join(outDir, 'sheets')} and delete any bad cut, then rerun with --report to refresh sheets.`);
}

main().catch(error => { console.error(error.message); process.exit(1); });
