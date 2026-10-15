// Media jobs: the media work act cannot do because it needs a local file or the server's time. Upload, replace, link
// import, download, and waiting on processing. Rename, move, remove, retry and bins are plain store actions (act); the
// "media" help topic has their recipes.
//
// Uploads go through the editor's own queue (store.uploadMedia / replaceMedia -> src/services/upload.ts): resumable
// 8 MiB chunks with checksums, two files at a time, running inside this MCP process. A File from fs.openAsBlob stays
// lazy, so a 10 GB original is never read into memory. Media rows are the server's: results arrive through refresh().
import { homedir } from 'node:os';
import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, parse, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { uploadQueue, pauseUpload, dismissUpload, type UploadJob } from '../../src/services/upload.ts';
import { projectBins } from '../../src/state/store.ts';
import type { MediaAsset } from '../../src/state/models.ts';
import { flush } from '../session.ts';
import { clock, secs } from '../views.ts';
import { call, refresh, edit, handle, need, media, project, timeline, store, done, sleep, type JobDef, type Poller, type Step } from './kit.ts';
// A path the model writes as ~/… means the home folder, as in a shell.
const expand = (path: string) => resolve(path.replace(/^~(?=$|[\\/])/, homedir()));

/** What a folder upload picks up (scripts/import-folder.mjs:38; that script runs when imported, so the list is copied).
 *  A file named directly goes up whatever its extension. */
export const EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mxf', '.avi', '.mkv', '.webm', '.wav', '.mp3', '.aac', '.aiff', '.aif', '.flac', '.m4a', '.ogg', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.heic'];
const MB = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;
const later = (s: number) => s >= 90 ? `${Math.round(s / 60)}m` : `${Math.round(s)}s`;

type Local = { path: string; name: string; size: number; lastModified: number };
/** Files and folders (recursive, no dot files) -> what to upload. A name two folders share takes its folder path,
 *  "A · C0001.MP4", like scripts/import-folder.mjs. lastModified is whole ms: the upload fingerprint must match after a restart. */
export async function localFiles(paths: string[]): Promise<Local[]> {
  const found = new Map<string, Local & { rel: string }>();
  for (const given of paths) {
    const root = expand(given), info = await stat(root).catch(() => null);
    if (!info) throw new Error(`Nothing at ${root}.`);
    const rels = info.isFile() ? [''] : (await readdir(root, { recursive: true })).filter(rel => !rel.split(sep).some(part => part.startsWith('.')) && EXTENSIONS.includes(extname(rel).toLowerCase())).sort();
    for (const rel of rels) {
      const path = rel ? join(root, rel) : root, file = rel ? await stat(path) : info;
      if (file.isFile()) found.set(path, { path, rel: rel || basename(path), name: basename(path), size: file.size, lastModified: Math.floor(file.mtimeMs) });
    }
  }
  const all = [...found.values()];
  return all.map(({ rel, ...f }) => all.filter(o => o.name === f.name).length > 1 ? { ...f, name: rel.split(sep).join(' · ') } : f);
}

/** A bin by id or name; a name no bin has becomes a new bin (saved before anything moves into it). */
async function binFor(wanted: string) {
  const want = wanted.toLowerCase(), found = projectBins(project(), store.getState().media).find(b => b.id === wanted || b.name.toLowerCase() === want);
  if (found) return found;
  const id = (await edit(run => run('createBin', wanted))).value as string | undefined;
  if (!id) throw new Error(`Could not create the bin "${wanted}".`);
  return { id, name: wanted };
}

/** Run a store action that takes a File (act cannot carry one) until it has queued, or throw the reason it refused. */
async function started(action: () => void, queued: () => boolean) {
  const caught: string[] = [], notify = store.getState().notify;
  store.setState({ notify: (title, kind = 'info', detail) => { if (kind !== 'success') caught.push(detail ? `${title} — ${detail}` : title); notify(title, kind, detail); } });
  try {
    action();
    for (const end = Date.now() + 20_000; !queued() && !caught.length && Date.now() < end;) await sleep(100);
  } finally { store.setState({ notify }); }
  if (!queued()) throw new Error(caught[0] ?? 'The upload did not start.');
}

type Item = { name: string; key?: string; id?: string };
type Line = { text: string; end: boolean; ok?: boolean };
/** One media's state: the client transfer while it lasts (upload.ts job), then the server row. */
function describe(item: Item, jobs: Map<string, UploadJob>, rows: MediaAsset[], final: boolean): Line {
  const job = item.key ? jobs.get(item.key) : undefined, id = item.id ?? job?.assetId, row = id ? rows.find(m => m.id === id) : undefined;
  const name = `${id ? `${handle(id)} ` : ''}${row?.name ?? item.name}`;
  if (job && job.status !== 'uploaded') {
    const p = job.progress, pct = p.total ? Math.floor(p.bytes / p.total * 100) : 0;
    if (job.status === 'failed') return { end: true, text: `${name} upload failed: ${job.error ?? 'no reason given'}` };
    if (job.status === 'paused') return { end: true, text: `${name} upload paused at ${pct}%; the same upload again resumes it` };
    if (job.status === 'queued') return { end: false, text: `${name} waiting to upload` };
    return { end: false, text: `${name} uploading ${pct}% of ${MB(p.total)}${p.speed ? ` ${MB(p.speed)}/s` : ''}${p.remaining ? ` ~${later(p.remaining)}` : ''}${/^(Queued|Uploading|Connecting|Uploaded)$/.test(p.message) ? '' : ` · ${p.message}`}` };
  }
  if (!row) return { end: true, text: `${name} is no longer in the project` };
  // No transfer in this process (it restarted, or another editor's upload): nothing here will finish it.
  if (row.status === 'uploading' && !job) return { end: true, text: `${name} upload not running here (${Math.round(row.progress)}%); upload the same file again to resume (if no bytes arrived it makes a new row: removeMedia this one)` };
  if (row.status === 'failed') return { end: true, text: `${name} failed: ${row.error ?? 'no reason given'}` };
  if (row.status === 'ready') {
    const finishing = !!row.preparationStage && !row.error;
    const format = `${row.kind} ${clock(row.duration)}${row.kind !== 'audio' && row.resolution ? ` ${row.resolution.replace(/ /g, '')}` : ''}${row.fps ? ` ${row.fps}fps` : ''}`;
    return { end: !(final && finishing), ok: true, text: `${name} ready ${format}${row.error ? ` · ${row.error}` : finishing ? ` · ${row.preparationStage}` : ''}` };
  }
  return { end: false, text: `${name} ${row.status} ${Math.round(row.progress)}%${row.preparationStage ? ` ${row.preparationStage}` : ''}` };
}
function report(items: Item[], jobs: Map<string, UploadJob>, final: boolean): Step {
  const lines = items.map(item => describe(item, jobs, store.getState().media, final));
  const ready = lines.filter(l => l.ok && l.end).length, failed = lines.filter(l => l.end && !l.ok).length, busy = lines.length - ready - failed;
  const head = `${busy ? 'Working' : 'Done'}: ${[ready && `${ready} ready`, busy && `${busy} in progress`, failed && `${failed} not done (help media: retry)`].filter(Boolean).join(', ')}`;
  const shown = lines.length > 40 ? [...lines.filter(l => !l.ok), ...lines.filter(l => l.ok)].slice(0, 40) : lines;
  return { done: !busy, text: [head, ...shown.map(l => l.text), ...(lines.length > shown.length ? [`… ${lines.length - shown.length} more ready`] : [])].join('\n') };
}

type Follow = { final?: boolean; note?: string; bin?: { id: string; projectId: string }; place?: { at: number; track?: string }; cancel?: () => Promise<void> };
/** `at` (s) and optional `track` from a job's params: where its media goes on the open timeline once ready, like a file drop on a lane. */
const placeOf = (params: Record<string, unknown>) => {
  if (params.at === undefined) return undefined;
  const at = Number(params.at);
  if (!Number.isFinite(at) || at < 0) throw new Error('at is seconds on the timeline, 0 or more.');
  return { at, track: params.track === undefined ? undefined : String(params.track) };
};
/** Polls until every item is ready or failed. With a bin, each new row moves there once the server has it; with place, the ready ones then go on the timeline, end to end. */
function follow(label: string, items: Item[], opts: Follow = {}): Poller {
  return {
    label,
    async poll() {
      // Read the transfers before refreshing: an upload already marked done is then always in the refreshed rows.
      const jobs = new Map(uploadQueue.getState().jobs.map(j => [j.key, j]));
      await refresh();
      let note = opts.note ?? '';
      if (opts.bin) {
        const rows = store.getState().media, ids = items.map(i => i.id ?? (i.key ? jobs.get(i.key)?.assetId : undefined));
        const move = rows.filter(m => ids.includes(m.id) && m.binId !== opts.bin!.id && m.status !== 'failed').map(m => m.id);
        // store.moveMedia's request, awaited, and for the project the upload started in even if another is open now.
        if (move.length) try { await call('/media/move', { method: 'POST', json: { projectId: opts.bin.projectId, binId: opts.bin.id, mediaIds: move } }); await refresh(); }
        catch (error) { note += `\nbin move failed: ${error instanceof Error ? error.message : error}`; }
      }
      const step = report(items, jobs, !!opts.final);
      if (step.done && opts.place) {
        const rows = store.getState().media, ids = items.map(i => i.id ?? (i.key ? jobs.get(i.key)?.assetId : undefined)).filter(id => rows.some(m => m.id === id && m.status === 'ready'));
        if (ids.length) try { note += `\n${(await edit(run => run('addMediaToTimeline', ids, opts.place!.at, opts.place!.track))).text}`; }
        catch (error) { note += `\nnot placed: ${error instanceof Error ? error.message : error}`; }
      }
      return { ...step, text: note ? `${note.trim()}\n${step.text}` : step.text };
    },
    ...(opts.cancel ? { cancel: opts.cancel } : {}),
  };
}
const pauseAll = (keys: string[]) => async () => {
  for (const key of keys) if (['queued', 'uploading'].includes(uploadQueue.getState().jobs.find(j => j.key === key)?.status ?? '')) pauseUpload(key);
};
const fileOf = async (path: string, name = basename(path)) => { const info = await stat(path); return new File([await openAsBlob(path)], name, { lastModified: Math.floor(info.mtimeMs) }); };
// upload.ts keys a transfer `${projectId}:${name}:${size}:${lastModified}` (+ `:${assetId}` for a replacement).
const keyOf = (projectId: string, file: File, assetId?: string) => `${projectId}:${file.name}:${file.size}:${file.lastModified}${assetId ? `:${assetId}` : ''}`;

export const jobs: Record<string, JobDef> = {
  upload: {
    doc: '{paths:[file|folder], bin?, force?, at?, track?} upload local media into the open project → @media once ready (at:s places it); rerun resumes. help media',
    async start(params) {
      const paths = typeof params.paths === 'string' ? [params.paths] : need<string[]>(params, 'paths', 'array');
      const p = project(), place = placeOf(params), list = await localFiles(paths);
      if (!list.length) throw new Error(`No media files there (folders take ${EXTENSIONS.join(' ')}).`);
      const { maxUploadBytes } = await call<{ maxUploadBytes: number }>('/uploads/info');
      const big = list.find(f => f.size > maxUploadBytes);
      if (big) throw new Error(`${big.name} is ${MB(big.size)}; this server takes up to ${MB(maxUploadBytes)} per file.`);
      // A retried tool call must not import twice; the queue itself only resumes unfinished uploads.
      const have = store.getState().media.filter(m => m.projectId === p.id && !['uploading', 'failed'].includes(m.status));
      const skip = list.filter(f => !f.size || (!params.force && have.some(m => m.name === f.name)));
      const notes = skip.map(f => f.size ? `skipped ${handle(have.find(m => m.name === f.name)!.id)} ${f.name}: already in the project (force:true uploads it again)` : `skipped ${f.name}: empty file`);
      const todo = list.filter(f => !skip.includes(f));
      if (!todo.length) return done(notes.join('\n'));
      const bin = params.bin ? await binFor(String(params.bin)) : undefined;
      const files = await Promise.all(todo.map(f => fileOf(f.path, f.name))), keys = files.map(f => keyOf(p.id, f));
      // A transfer this process already finished would swallow the new one (the media was removed, or force).
      for (const key of keys) if (uploadQueue.getState().jobs.find(j => j.key === key)?.status === 'uploaded') dismissUpload(key);
      await started(() => store.getState().uploadMedia(files), () => keys.every(k => uploadQueue.getState().jobs.some(j => j.key === k)));
      const note = [`Uploading ${files.length} (${MB(todo.reduce((n, f) => n + f.size, 0))}) to "${p.name}"${bin ? ` → bin ${bin.name}` : ''}`, ...notes].join('\n');
      return follow(`uploading ${files.length} file${files.length === 1 ? '' : 's'}`, todo.map((f, i) => ({ name: f.name, key: keys[i] })), { note, bin: bin && { id: bin.id, projectId: p.id }, place, cancel: pauseAll(keys) });
    },
  },
  replace: {
    doc: '{media, path} upload a new original into @media (same id, so clips stay) → ready line',
    async start(params) {
      const asset = media(need(params, 'media')), path = expand(need(params, 'path'));
      if (!(await stat(path).catch(() => null))?.isFile()) throw new Error(`No file at ${path}.`);
      if (asset.projectId !== store.getState().projectId) throw new Error(`${handle(asset.id)} is in another project; open that project first.`);
      const file = await fileOf(path), key = keyOf(asset.projectId, file, asset.id);
      const earlier = uploadQueue.getState().jobs.find(j => j.key === key);
      if (earlier && ['queued', 'uploading'].includes(earlier.status)) throw new Error(`${handle(asset.id)} is already being replaced with this file; job pending{media:["${handle(asset.id)}"]} follows it.`);
      // A new replace starts over on the server, so an old transfer of the same file must not stand in for it.
      if (earlier) dismissUpload(key);
      // The editor warns before a shorter replacement (MediaPanel chooseReplacement); here the model gets the number.
      const used = Math.max(0, ...store.getState().clips.filter(c => c.mediaId === asset.id).map(c => c.sourceIn + (c.properties.freeze ? 0 : c.duration * Number(c.properties.speed || 100) / 100)));
      await started(() => store.getState().replaceMedia(asset.id, file), () => uploadQueue.getState().jobs.some(j => j.key === key));
      const note = `Replacing ${handle(asset.id)} ${asset.name} with ${file.name} (${MB(file.size)})${used ? `; its clips use source up to ${secs(used)} s` : ''}`;
      return follow(`replacing ${handle(asset.id)}`, [{ name: file.name, key, id: asset.id }], { note, cancel: pauseAll([key]) });
    },
  },
  link: {
    doc: '{url, audio?, quality?:720|1080|2160, bin?, at?, track?} import a YouTube video or Spotify track (always audio) → @media once ready (at:s places it)',
    async start(params) {
      const url = need(params, 'url'), p = project(), place = placeOf(params);
      // The editor's LinkImport form: save pending edits, then the same request.
      await flush();
      const { asset } = await call<{ asset: MediaAsset }>('/media/import-link', { method: 'POST', json: { projectId: p.id, url, mode: params.audio ? 'audio' : 'video', quality: params.quality ?? 1080 } });
      // The import already runs, so a bin that cannot be made is a note, not a lost job.
      let bin: { id: string; name: string } | undefined, binNote = '';
      if (params.bin) try { bin = await binFor(String(params.bin)); } catch (error) { binNote = `\nno bin: ${error instanceof Error ? error.message : error}`; }
      await refresh();
      return follow(`importing ${handle(asset.id)}`, [{ name: asset.name, id: asset.id }], {
        note: `Importing ${url}${bin ? ` → bin ${bin.name}` : ''}${binNote}`, bin: bin && { id: bin.id, projectId: p.id }, place,
        async cancel() { await call(`/media/${asset.id}/cancel`, { method: 'POST' }); await refresh(); },
      });
    },
  },
  still: {
    doc: '{time?, timeline?} Grab still: the timeline frame at time (default playhead), rendered like Export at full size → PNG @media in bin Stills',
    async start(params) {
      const p = project(), tl = timeline(params.timeline), t = params.time === undefined ? store.getState().playhead : Number(params.time);
      // The editor's Grab still button: save pending edits, then the same request.
      await flush();
      const { asset } = await call<{ asset: MediaAsset }>('/media/still', { method: 'POST', json: { projectId: p.id, timelineId: tl.id, t } });
      await refresh();
      return follow(`grabbing ${handle(asset.id)}`, [{ name: asset.name, id: asset.id }]);
    },
  },
  download: {
    doc: '{media, to, proxy?, overwrite?} save an original (proxy: its playable preview) to a local file or folder',
    async start(params) {
      const to = expand(need(params, 'to')), asset = media(need(params, 'media'));
      let source: string, name: string;
      if (!params.proxy) { source = `/api/media/${asset.id}/original?download`; name = asset.name; }
      else if (!asset.proxyUrl) throw new Error(`${handle(asset.id)} has no playable preview yet (${asset.status}).`);
      else { source = asset.proxyUrl; name = `${parse(asset.name).name} preview${extname(asset.proxyUrl.split('?')[0])}`; }
      const into = /[\\/]$/.test(String(params.to)) || (await stat(to).catch(() => null))?.isDirectory();
      const controller = new AbortController(), response = await fetch(source, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`The server refused the download: ${(await response.json().catch(() => null))?.error ?? response.status}`);
      const header = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('content-disposition') ?? '')?.[1];
      if (header) name = decodeURIComponent(header);
      const dest = into ? join(to, basename(name)) : to, part = `${dest}.part`, total = Number(response.headers.get('content-length')) || 0;
      if (!params.overwrite && await stat(dest).then(() => true, () => false)) { controller.abort(); throw new Error(`${dest} already exists; overwrite:true replaces it.`); }
      await mkdir(dirname(dest), { recursive: true });
      // Streamed to a .part file and renamed when whole: an interrupted download never looks finished.
      let got = 0, finished = false, failure: unknown;
      const work = pipeline(Readable.fromWeb(response.body as never), async function* (chunks: AsyncIterable<Buffer>) { for await (const chunk of chunks) { got += chunk.length; yield chunk; } }, createWriteStream(part))
        .then(() => { if (total && got !== total) throw new Error(`The download stopped at ${MB(got)} of ${MB(total)}; run it again.`); return rename(part, dest); })
        .then(() => { finished = true; }, async error => { failure = error; await rm(part, { force: true }); });
      return {
        label: `downloading ${basename(dest)}`,
        async poll() {
          await Promise.race([work, sleep(1000)]);
          if (failure) throw failure;
          return finished ? done(`saved ${dest} (${MB(got)})`) : { done: false, text: `downloading ${basename(dest)} ${total ? `${Math.floor(got / total * 100)}% of ${MB(total)}` : MB(got)}` };
        },
        async cancel() { controller.abort(); await work; },
      };
    },
  },
  pending: {
    doc: '{media?:[@m], final?} wait for uploads and processing (default: everything pending in the project; final: extra previews too)',
    async start(params) {
      const p = project(), final = params.final === true;
      const asked = params.media === undefined ? undefined : ([] as unknown[]).concat(params.media).map(id => media(id).id);
      const transfers = uploadQueue.getState().jobs.filter(j => j.projectId === p.id && j.status !== 'uploaded' && (!asked || asked.includes(j.assetId ?? '')));
      const ids = asked ?? store.getState().media.filter(m => m.projectId === p.id && (!['ready', 'failed'].includes(m.status) || (final && m.preparationStage && !m.error))).map(m => m.id);
      const items: Item[] = [...ids.map(id => ({ id, name: media(id).name, key: transfers.find(j => j.assetId === id)?.key })), ...transfers.filter(j => !ids.includes(j.assetId ?? '')).map(j => ({ name: j.name, key: j.key }))];
      if (!items.length) return done('Nothing pending: every media in this project is ready or failed.');
      return follow(`waiting on ${items.length} media`, items, { final });
    },
  },
};

export const topics: Record<string, string> = {
  media: [
    'media: upload, link import, replace, download, rename, bins, remove, retry. The media tool lists rows (first line: bin ids).',
    'status: uploading (bytes arriving) | downloading (link import) → processing N% <stage> → ready | failed: <error>. ready = playable and allowed on a timeline; extra previews may still run (a stage after "ready"; job pending{final:true} waits for them). ready with an error lost only extra previews and still plays.',
    'jobs: upload, replace, link, still, download, pending (help jobs has their params). They wait up to `wait` s, then give an id for job status.',
    `upload: folders go in recursively, skipping dot files, taking ${EXTENSIONS.join(' ')}. A file whose name is already in the project is skipped unless force:true. Max size per file is the server's (default 10 GiB). Kind comes from the extension: audio wav mp3 aac aif(f) flac m4a ogg; image png jpg webp gif tif bmp heic; else video.`,
    'upload resume: transfers run inside this MCP process. job cancel pauses them; running the same upload again (same paths) resumes from the server\'s offset, also after an MCP restart; one stopped before its first byte starts a new row instead (removeMedia the stuck one). An unfinished upload left alone 24 h is discarded by the server.',
    'replace: same kind (by extension) as the media; refused while it is processing or the project has an export or captions running (a refused last chunk fails the transfer: run it again later). Clips keep their in points: a shorter file leaves them past its end.',
    'link: YouTube watch / youtu.be / shorts / live, or open.spotify.com/track (matched audio). Needs the server\'s link importer (npm run setup:imports); without it the row fails saying so. job cancel stops the download.',
    'download: {media, to} the original; proxy:true its playable preview (mp4, m4a for audio, png for images). to = file path or existing folder (or one ending in /); an existing file needs overwrite:true. Exports: job exports{job, download}.',
    'rename: act renameMedia(@m, "Interview A.mov"). No extension check; the kind never changes.',
    'bins: act moveMedia([@m, …], binId). act createBin("Cam A") prints the new id; move into it in the next act call (upload/link bin: creates it by name). renameBin(id, name). deleteBin(id) sends its media back to broll (video, images) or audio; those two cannot be deleted. Bin edits are not undoable.',
    'remove: act removeMedia(@m). Refused while a clip or snapshot uses it (delete those clips first) or while an export or caption job runs.',
    'retry: act retryMedia(@m) reprocesses from the saved original: failed rows, "Processing was interrupted" after a server restart, or to rebuild previews. A failed or paused upload: run the same upload job again.',
    'timeline: act addMediaToTimeline(@m | [@m, …], start?, trackId?, insert?) takes ready media only.',
  ].join('\n'),
};
