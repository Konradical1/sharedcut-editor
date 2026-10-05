// Export (the Deliver workspace) and the DaVinci Resolve round trip. An export is a server job: POST /api/renders
// with the settings Deliver builds, then GET /api/renders until it completes, then stream the file to disk. Render
// jobs are the server's alone (a save that touches them is refused), so they are never written through the store.
import { createWriteStream, existsSync, openAsBlob, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { call, ApiFailure, refresh, handle, need, clip, project, timeline, store, done, sleep, type JobDef, type Poller, type Step } from './kit.ts';
import { flush, config } from '../session.ts';
import { timecode } from '../../src/services/timecode.ts';
import { uploadSource } from '../../src/services/upload.ts';
import type { EditorStore } from '../../src/state/store.ts';
import type { MediaAsset, RenderJob } from '../../src/state/models.ts';

// Deliver's choices. They live inside src/workspaces/DeliverWorkspace.tsx, a React file Node cannot import;
// export.test.ts fails when they drift from it or from what server/media.ts accepts.
export const PRESETS = [
  { name: 'Quick Export', codec: 'H.264', resolution: '1920 × 1080', quality: 'High · 20 Mb/s' },
  { name: 'YouTube', codec: 'H.264', resolution: '3840 × 2160', quality: 'Maximum · 50 Mb/s' },
  { name: 'High Quality Master', codec: 'Apple ProRes 422 HQ', resolution: '3840 × 2160', quality: 'Visually lossless' },
  { name: 'Custom', codec: 'H.264', resolution: '1920 × 1080', quality: 'High · 20 Mb/s' },
];
export const CODECS = ['H.264', 'H.265 / HEVC', 'Apple ProRes 422 HQ', 'Apple ProRes 4444'];
export const QUALITIES = ['Automatic', 'High · 20 Mb/s', 'Maximum · 50 Mb/s', 'Visually lossless'];
export const AUDIO = ['AAC · 320 kb/s · 48 kHz', 'AAC · 192 kb/s · 48 kHz', 'Linear PCM · 24-bit · 48 kHz', 'Linear PCM · 16-bit · 48 kHz', 'Disabled'];
export const FPS = ['23.976', '24', '25', '29.97', '30', '50', '59.94', '60'];
export const SIZES = ['1920 × 1080', '3840 × 2160', '2560 × 1440', '1080 × 1920', '1280 × 720'];

const norm = (value: unknown) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
/** The exact server string for a loose one: "h265" → "H.265 / HEVC", "pcm24" → "Linear PCM · 24-bit · 48 kHz". */
function pick(list: string[], value: unknown, key: string) {
  const want = norm(value), found = want ? list.find(o => norm(o) === want) ?? list.find(o => norm(o).includes(want)) : undefined;
  if (!found) throw new Error(`params.${key} "${value}" is not one of: ${list.join(' | ')}`);
  return found;
}
const shape = (size: string) => { const [w, h] = size.split(/[×x]/).map(Number); return w / h; };

/** The POST /api/renders body for the open timeline, built as Deliver's addToQueue builds it. */
export function renderRequest(s: EditorStore, p: Record<string, any>) {
  const proj = s.projects.find(x => x.id === s.projectId), tl = s.timelines.find(t => t.id === s.timelineId);
  if (!proj || !tl) throw new Error('No timeline open.');
  const projectResolution = proj.resolution || '1920 × 1080', projectFps = proj.fps || 24;
  // No preset is Deliver as it opens: Quick Export at the project's own size. Picking one applies its size only when
  // it has the project's shape; changing codec or size makes it Custom, as the UI does.
  let preset = 'Quick Export', codec = 'H.264', quality = 'High · 20 Mb/s', resolution = projectResolution;
  if (p.preset !== undefined) {
    const def = PRESETS.find(x => x.name === pick(PRESETS.map(x => x.name), p.preset, 'preset'))!;
    preset = def.name;
    if (preset !== 'Custom') { codec = def.codec; quality = def.quality; resolution = Math.abs(shape(def.resolution) - shape(projectResolution)) < .01 ? def.resolution : projectResolution; }
  }
  if (p.codec !== undefined) { const value = pick(CODECS, p.codec, 'codec'); if (value !== codec) { codec = value; preset = 'Custom'; } }
  if (p.resolution !== undefined) {
    const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(p.resolution).trim());
    if (!m) throw new Error('params.resolution is "width×height", e.g. "1920×1080".');
    const value = `${m[1]} × ${m[2]}`; if (value !== resolution) { resolution = value; preset = 'Custom'; }
  }
  if (p.quality !== undefined) quality = pick(QUALITIES, p.quality, 'quality');
  const fps = p.fps === undefined ? String(projectFps) : String(Number(p.fps));
  if (!(Number(fps) >= 1 && Number(fps) <= 120)) throw new Error('params.fps must be 1–120.');
  const audio = p.audio === undefined || p.audio === true ? AUDIO[0] : p.audio === false || /^(off|none|no|disabled?)$/i.test(String(p.audio)) ? 'Disabled' : pick(AUDIO, p.audio, 'audio');
  if (audio.startsWith('Linear PCM') && !codec.includes('ProRes')) throw new Error('Linear PCM needs a ProRes codec (.mov). Use AAC for H.264/H.265.');
  const clips = s.clips.filter(c => c.timelineId === tl.id);
  let range = 'Entire timeline', from = 0, to = Math.max(0, ...clips.map(c => c.start + c.duration));
  if (p.clip !== undefined) {
    const c = clips.find(x => x.id === p.clip);
    if (!c) throw new Error(`No clip ${handle(String(p.clip))} on "${tl.name}".`);
    range = 'Selected clip'; from = c.start; to = c.start + c.duration;
  } else if (p.in !== undefined || p.out !== undefined) { range = 'In / Out range'; from = Number(p.in ?? 0); to = Number(p.out ?? to); }
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error('params.in and params.out are seconds.');
  // Deliver checks a frame of the project; the server a frame of the export: the longer of the two.
  if (from < 0 || to - from < 1 / Math.min(projectFps, Number(fps)) - 1e-9) throw new Error('Choose a render range with at least one frame.');
  if (to > tl.duration + 1e-6) throw new Error(`The range ends at ${to}s, past the timeline's length (${tl.duration}s).`);
  const extension = codec.includes('ProRes') ? 'mov' : 'mp4';
  const filename = String(p.name ?? `${(proj.name || 'Untitled').replace(/[^a-zA-Z0-9_-]+/g, '_')}_Final`).trim().replace(/\.(mp4|mov)$/i, '');
  if (!filename || /[/\\\u0000-\u001f]/.test(filename)) throw new Error('Give your export a filename without slashes.');
  if (filename.length > 150) throw new Error('params.name is at most 150 characters.'); // the server's limit is 160 with the extension
  const settings: Record<string, string> = {
    destination: 'Server exports', resolution, fps, codec, quality, masterGain: String(s.settings.masterGain ?? 0), masterMuted: String(s.settings.masterMuted ?? false),
    range, rangeIn: String(from), rangeOut: String(to), duration: String(to - from), timecodeIn: timecode(from, projectFps), timecodeOut: timecode(to, projectFps), sourceFrameRate: String(projectFps),
    audio, subtitles: 'None', timeline: tl.name || 'Main timeline', timelineId: tl.id,
  };
  return { projectId: proj.id, name: `${filename}.${extension}`, preset, settings };
}

const short = (audio: string) => audio === 'Disabled' ? 'no audio' : audio.replace(/ · 48 kHz$/, '');
const summary = (r: { name: string; preset: string; settings: Record<string, string> }) =>
  `${r.preset} · ${r.settings.codec} ${r.settings.resolution} ${r.settings.fps}fps ${short(r.settings.audio)} · ${r.settings.timecodeIn}→${r.settings.timecodeOut} (${Math.round(Number(r.settings.duration) * 100) / 100}s) · ${r.name}`;
export const line = (j: RenderJob) => `${handle(j.id)} ${j.status}${j.status === 'rendering' ? ` ${Math.floor(j.progress)}%` : ''}${j.status === 'complete' ? '' : ` · ${(j.error || j.remaining).replace(/\s+/g, ' ')}`} · ${j.name}`;
const mb = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.ceil(bytes / 1e3)} KB`;
const expand = (path: string) => resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
// A tunnel blip or a server restart (hard kill) is not the export failing.
const transient = (error: unknown) => error instanceof TypeError || error instanceof ApiFailure && (error.status >= 500 || error.status === 429);

/** `path` itself, or `name` inside it when it is a folder (or ends in a slash). Into a folder nothing is overwritten:
 *  a taken name becomes "name (2).ext". */
function place(path: string, name: string) {
  const folder = expand(path);
  if (!/[\\/]$/.test(path) && !(existsSync(folder) && statSync(folder).isDirectory())) return folder;
  const ext = extname(name), stem = name.slice(0, name.length - ext.length);
  let target = join(folder, name);
  for (let n = 2; existsSync(target); n++) target = join(folder, `${stem} (${n})${ext}`);
  return target;
}
async function writeOut(path: string, name: string, data: string | Buffer) {
  const target = place(path, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  return target;
}

/** Stream a finished export to disk. A .part file resumes with a Range request; nothing is held in memory. */
export async function download(job: RenderJob, path: string, onBytes: (bytes: number) => void = () => {}, signal?: AbortSignal) {
  const extension = job.settings.codec?.includes('ProRes') ? '.mov' : '.mp4';
  const target = place(path, job.name.toLowerCase().endsWith(extension) ? job.name : job.name + extension);
  await mkdir(dirname(target), { recursive: true });
  // The job id in the part name keeps one export's bytes from resuming into another's.
  const part = `${target}.${handle(job.id).slice(1)}.part`;
  const { url, cookie } = config();
  for (;;) {
    const have = existsSync(part) ? statSync(part).size : 0;
    // An absolute URL skips the session's request tracking, so a long download never holds up an edit.
    const response = await fetch(`${url}/api/renders/${encodeURIComponent(job.id)}/download`, { headers: { cookie, ...(have ? { range: `bytes=${have}-` } : {}) }, signal });
    const total = Number(response.headers.get('content-range')?.split('/')[1] ?? response.headers.get('content-length'));
    // 416: the part already holds the whole file (a rename that never happened), or more than it: finish or start over.
    if (response.status === 416 && have) { await response.body?.cancel(); if (total === have) break; await rm(part); continue; }
    if (!response.ok || !response.body) throw new Error(`Download of ${handle(job.id)} failed (${response.status}).`);
    let bytes = response.status === 206 ? have : 0;
    const count = new Transform({ transform(chunk, _encoding, next) { onBytes(bytes += chunk.length); next(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body as never), count, createWriteStream(part, { flags: response.status === 206 ? 'a' : 'w' }));
    if (total && statSync(part).size !== total) throw new Error(`Download of ${handle(job.id)} stopped at ${mb(statSync(part).size)} of ${mb(total)}.`);
    break;
  }
  await rename(part, target);
  return { path: target, size: statSync(target).size };
}

/** A poller around work that runs on its own (a download, an import); poll reports its latest progress line. */
function background(label: string, work: (report: (text: string) => void, signal: AbortSignal) => Promise<string>): Poller {
  let text = `${label}…`, result: string | undefined, failure: unknown;
  const abort = new AbortController();
  const task = work(next => { text = next; }, abort.signal).then(r => { result = r; }, error => { failure = error; });
  return {
    label,
    async poll() {
      await Promise.race([task, sleep(1000)]);
      if (failure) throw failure;
      return result !== undefined ? done(result) : { done: false, text };
    },
    async cancel() { abort.abort(); await task; },
  };
}

/** Follow one render until it completes or fails, then optionally download it. */
function watch(id: string, path?: string, head = ''): Poller {
  let saving: Poller | undefined, unreachable = 0;
  const find = async () => (await call<{ jobs: RenderJob[] }>('/renders')).jobs.find(j => j.id === id);
  const poll = async (): Promise<Step> => {
    if (saving) { const step = await saving.poll(); return { ...step, text: head + step.text }; }
    let job: RenderJob | undefined;
    try { job = await find(); unreachable = 0; }
    catch (error) {
      if (!transient(error)) throw error;
      unreachable ||= Date.now();
      if (Date.now() - unreachable > 10 * 60_000) throw new Error(`The server has been unreachable for 10 minutes. The export may still finish: job exports{job:"${handle(id)}"}.`);
      return { done: false, text: `${head}${handle(id)} · server unreachable, retrying` };
    }
    if (!job) throw new Error(`Export ${handle(id)} not found.`);
    if (job.status === 'failed') throw new Error(`${head}${line(job)}`);
    if (job.status !== 'complete') return { done: false, text: head + line(job) };
    if (!path) return done(`${head}${line(job)}\nsave it: job exports{job:"${handle(id)}", download:"<path>"}`);
    const finished = job;
    saving = background(`${line(finished)} · downloading`, async (report, signal) => {
      try {
        const saved = await download(finished, path, bytes => report(`${line(finished)} · downloading ${mb(bytes)}`), signal);
        return `${line(finished)} · saved ${saved.path} (${mb(saved.size)})`;
      } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(`${error instanceof Error ? error.message : error} The export is safe; resume: job exports{job:"${handle(id)}", download:"${path}"}`);
      }
    });
    return poll();
  };
  return {
    label: `export ${handle(id)}`,
    poll,
    // Cancelling a download keeps the finished export; only a render still going is stopped (DELETE on a complete
    // export would remove its file, so the status is read again first).
    async cancel() {
      if (saving) return saving.cancel?.();
      const job = await find();
      if (job && (job.status === 'waiting' || job.status === 'rendering')) await call(`/renders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}

async function queue(body: { projectId: string; name: string; preset: string; settings: Record<string, string> }) {
  // The server renders its own saved copy, taken at this POST: anything unsaved would be missing.
  await flush();
  try { return (await call<{ job: RenderJob }>('/renders', { method: 'POST', json: body })).job; }
  catch (error) {
    if (error instanceof ApiFailure && error.status === 403) throw new Error('Exporting needs the Owner or Editor role on this project.');
    if (error instanceof ApiFailure && error.status === 429) throw new Error('The server render queue is full (20 waiting). Try again later.');
    throw error;
  } finally { await refresh(); }
}

/** Import a Resolve bridge bundle: the manifest and OTIOs, then the LUTs/stills/DRP, then the camera originals. */
function importBundle(p: Record<string, any>) {
  const folder = expand(need(p, 'path')), folders = (Array.isArray(p.media) ? p.media : p.media ? [p.media] : []).map((f: unknown) => expand(String(f)));
  return background(`importing ${basename(folder)}`, async (report, signal) => {
    const manifest = JSON.parse(await readFile(join(folder, 'project.frameline.json'), 'utf8').catch(() => { throw new Error(`No project.frameline.json in ${folder}. Run the bridge in Resolve first (help export).`); }));
    if (manifest.format !== 'frameline-resolve' || !Array.isArray(manifest.timelines)) throw new Error('That folder is not a SharedCut Resolve bridge export.');
    const otios = await Promise.all(manifest.timelines.map((_: unknown, i: number) => readFile(join(folder, `timeline-${i + 1}.otio`), 'utf8').then(JSON.parse)));
    // The same bundle always maps to the same id, so running it again resumes instead of duplicating.
    const projectId = 'resolve-' + (p.fresh ? randomUUID().replace(/-/g, '') : createHash('sha256').update(JSON.stringify([manifest, otios])).digest('hex')).slice(0, 32);
    await flush();
    const imported = await call<{ projectId: string; files: string[]; warnings: string[]; media: MediaAsset[] }>('/resolve/import', { method: 'POST', json: { projectId, manifest, otios } });
    const unstored: string[] = [], missing: string[] = [];
    for (const name of imported.files) {
      if (name === 'project.frameline.json') continue;
      if (!existsSync(join(folder, name))) { unstored.push(name); continue; }
      report(`storing ${name}`);
      // 409: already stored (immutable). 413: over 32 MB, typically project.drp; the import works without it.
      try { await call(`/projects/${projectId}/resolve/${name}`, { method: 'PUT', body: await readFile(join(folder, name)) }); }
      catch (error) { if (!(error instanceof ApiFailure) || ![409, 413].includes(error.status)) throw error; if (error.status === 413) unstored.push(name); }
    }
    const sources = imported.media.filter(a => !a.sourceUrl);
    let found: string[] | undefined, uploaded = 0;
    for (const [i, asset] of sources.entries()) {
      signal.throwIfAborted();
      let source = asset.sourcePath && existsSync(asset.sourcePath) ? asset.sourcePath : undefined;
      if (!source && folders.length) {
        found ??= (await Promise.all(folders.map(async (f: string) => (await readdir(f, { recursive: true })).map(n => join(f, n))))).flat();
        const hits = found.filter(f => basename(f) === asset.name);
        if (hits.length > 1) { missing.push(`${asset.name} (ambiguous)`); continue; }
        source = hits[0];
      }
      if (!source) { missing.push(asset.name); continue; }
      const info = await stat(source);
      // Named and dated like the browser's File, so a browser upload of the same file resumes this one.
      await uploadSource(asset.id, new File([await openAsBlob(source)], basename(source), { lastModified: Math.trunc(info.mtimeMs) }), percent => report(`uploading ${asset.name} ${percent}% (${i + 1}/${sources.length})`), signal);
      uploaded++;
    }
    await refresh();
    const name = store.getState().projects.find(x => x.id === projectId)?.name ?? manifest.name;
    const list = (items: string[]) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? '…' : ''}`;
    return [`project ${handle(projectId)} "${name}" · ${imported.media.length} sources (${imported.media.length - sources.length + uploaded} uploaded${missing.length ? `, ${missing.length} missing: ${list(missing)}` : ''})`,
      `${imported.files.length - 1 - unstored.length} bundle files stored${unstored.length ? ` (not stored: ${list(unstored)})` : ''} · ${imported.warnings.length} warnings${imported.warnings.length ? `: ${imported.warnings.slice(0, 3).join(' | ')}` : ''}`,
      `open it: projects{open:"${handle(projectId)}"}${missing.length ? '. Run again with media:[folders] to upload the missing originals.' : ''}`].join('\n');
  });
}

export const jobs: Record<string, JobDef> = {
  export: {
    doc: '{timeline?, clip?|in?,out?, preset?, codec?, resolution?, fps?, quality?, audio?, name?, download?:path} renders the saved edit on the server → status, saved file. help export',
    async start(p) {
      project();
      const tl = p.timeline !== undefined ? timeline(p.timeline) : p.clip !== undefined ? timeline(clip(p.clip).timelineId) : timeline();
      const s = store.getState();
      if (tl.projectId !== s.projectId) s.openProject(tl.projectId);
      if (tl.id !== store.getState().timelineId) store.getState().setTimeline(tl.id);
      const body = renderRequest(store.getState(), p), job = await queue(body);
      return watch(job.id, p.download, `queued ${summary(body)}\n`);
    },
  },
  exports: {
    doc: '{} lists exports; {job, download?:path} waits for it and saves the file; {job, cancel:true} stops a render; {job, delete:true} deletes a finished file; {job, retry:true, download?} re-renders the current edit',
    async start(p) {
      const s = store.getState();
      if (p.job === undefined) {
        const list = s.renderJobs.filter(j => j.projectId === s.projectId).slice(0, 10);
        return done(list.length ? list.map(line).join('\n') : 'No exports in this project. job export queues one.');
      }
      const job = s.renderJobs.find(j => j.id === p.job);
      if (!job) throw new Error(`No export ${handle(String(p.job))}. job exports{} lists them.`);
      // The server has one DELETE: it stops a render, and on a finished export it deletes the file (and on a failed one
      // replaces its error), so each case needs its own word.
      if (p.cancel || p.delete) {
        const running = job.status === 'waiting' || job.status === 'rendering';
        if (job.status === 'failed') throw new Error(`${line(job)}: nothing to cancel or delete.`);
        if (!running && !p.delete) throw new Error(`${handle(job.id)} is complete; cancel would delete its file. Pass delete:true to do that.`);
        await call(`/renders/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
        await refresh();
        return done(running ? `${handle(job.id)} cancelled` : `${handle(job.id)} file deleted (record stays)`);
      }
      if (p.retry) {
        const next = await queue({ projectId: job.projectId, name: job.name, preset: job.preset, settings: job.settings });
        return watch(next.id, p.download, `${handle(next.id)} queued (retry of ${handle(job.id)}, current edit)\n`);
      }
      return watch(job.id, p.download);
    },
  },
  resolve: {
    doc: '{do:"otio"|"bridge", path, timeline?} saves the timeline as OTIO / the Resolve bridge script; {do:"import", path:bundle folder, media?:[folders], fresh?} imports a Resolve project',
    async start(p) {
      const what = need(p, 'do');
      if (what === 'import') return importBundle(p);
      const path = need(p, 'path');
      if (what === 'bridge') {
        const file = await writeOut(path, 'resolve-export.lua', await call<Buffer>('/resolve/bridge'));
        // Forward slashes: Lua reads a backslash in a string as an escape, and Windows accepts either.
        return done(`wrote ${file}\nin Resolve's Lua console: dofile("${file.replaceAll('\\', '/')}")("/absolute/empty/folder"), then job resolve{do:"import", path:"<that folder>"}`);
      }
      if (what !== 'otio') throw new Error('params.do is "otio", "bridge" or "import".');
      const tl = timeline(p.timeline);
      await flush();
      const result = await call<{ otio: unknown; warnings: string[] }>(`/projects/${encodeURIComponent(tl.projectId)}/resolve-export?timelineId=${encodeURIComponent(tl.id)}`);
      const file = await writeOut(path, 'SharedCut-timeline.otio', JSON.stringify(result.otio, null, 2));
      return done(`wrote ${file} · ${result.warnings.length} warnings${result.warnings.length ? `: ${result.warnings.slice(0, 3).join(' | ')}` : ''}`);
    },
  },
};

const presetLine = (p: typeof PRESETS[number]) => `${p.name}: ${p.codec} · ${p.resolution} · ${p.quality}`;
export const topics: Record<string, string> = {
  export: [
    'export: server exports (Deliver) and the DaVinci Resolve round trip. Jobs: export, exports, resolve.',
    'export renders the SAVED edit of the open timeline (or params.timeline / the clip\'s timeline) on the server. One export renders at a time server-wide; at most 20 wait. Needs Owner/Editor.',
    `presets (codec · size · quality): ${PRESETS.filter(p => p.name !== 'Custom').map(presetLine).join(' | ')} | Custom = your overrides. No preset = Quick Export at the project's own size (Deliver's default). A preset size of another shape (vertical project) falls back to the project size. Changing codec or size makes it Custom.`,
    `codec: ${CODECS.join(' | ')}. ProRes writes .mov, the rest .mp4 (the name's extension follows). Short forms work: h264, h265, prores, prores4444.`,
    `quality (H.264/H.265; ProRes ignores it): ${QUALITIES.join(' | ')}. Default ${PRESETS[0].quality}. Short: auto, high, max, lossless.`,
    `audio: ${AUDIO.join(' | ')}. Default ${AUDIO[0]}; Linear PCM needs ProRes. Short: aac320, aac192, pcm24, pcm16, off.`,
    `fps: default the project's; Deliver offers ${FPS.join(', ')} (server takes 1–120).`,
    `resolution "W×H": the project's aspect (±0.01), even sides 16–4096. Deliver offers the project size and ${SIZES.join(', ')} of that shape.`,
    'range: default the whole edit (0 → end of the last clip). clip:@h = that clip\'s span. in/out (seconds) = that span; a missing side is 0 / the end. At least one frame, not past the timeline length.',
    'name: default <Project>_Final, no slashes, ≤150 chars; the extension is added. download: a file path (overwritten) or a folder (→ the export name; a taken name gets " (2)"; ~ ok); streams with resume through a .part file.',
    'Master gain/mute come from account settings (act setSettings({masterGain:dB -60–12, masterMuted})); track mute/solo/gain apply. Visible caption tracks burn in; hide the track (act updateTrack(track,{hidden:true})) to leave them out. Subtitle files (SRT/VTT): job subtitles.',
    'status: waiting (Queued / Waiting for depth analysis) → rendering N% · stage · elapsed → complete | failed (error). "No new frames for Ns" on animated timelines is normal: they bake every frame. Progress stops at 99 until complete.',
    'exports{job, cancel:true} stops a waiting or rendering export; exports{job, delete:true} deletes a complete export\'s file (the record stays, as failed/Cancelled). retry queues the same settings against the CURRENT edit. job{kind:"cancel"} on a running export job stops the render, or only the download once it is complete.',
    'Resolve → SharedCut: 1) job resolve{do:"bridge", path} saves resolve-export.lua. 2) In Resolve\'s Lua console run the dofile line it prints, with an empty folder. 3) job resolve{do:"import", path:"<that folder>", media:["<footage folders>"]}.',
    'import: originals upload from the paths Resolve recorded, else by file name under media folders. Running it again resumes the same project (same bundle = same id); fresh:true makes a new project. A .drp alone cannot be imported.',
    'SharedCut → Resolve: job resolve{do:"otio", path, timeline?} writes an OTIO timeline for Resolve (File > Import > Timeline). Refused: overlapping clips on one track, and clips with no media file (titles, shapes, captions, compositions, adjustment clips).',
  ].join('\n'),
};
