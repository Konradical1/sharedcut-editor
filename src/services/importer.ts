// The importer page (sharedcut.com/importer): finding a Final Cut project's footage on the person's Mac, and timing their
// Wi-Fi. Pure functions plus a little DOM glue, and no editor store, so the page loads without the editor. The server
// shares fontKey, so both decide font matches the same way.
import { api } from './api.ts';
import type { FcpImport } from '../state/models.ts';

/** A font family or file name as a match key: lowercase letters and digits. "Futura PT" matches FuturaPT-Bold.otf by prefix. */
export const fontKey = (family: string) => family.toLowerCase().replace(/[^a-z0-9]/g, '');
/** A file or folder name as macOS compares it: case ignored, and composed (a name can reach the browser decomposed). */
export const nameKey = (name: string) => name.normalize('NFC').toLowerCase();
const segs = (path: string) => nameKey(path).split('/').filter(Boolean);
// How many trailing path components agree: 1 = only the file name, 2 = folder and name, and so on.
const suffix = (a: string[], b: string[]) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };

/** A footage file found on the Mac: `path` is the dropped item's name, then the folders below it, joined with "/". */
export type Found = { path: string; file: File };
/** A source of the project, as the dry run or GET /api/fcp/import/:id lists it. */
export type Source = { id: string; name: string; kind?: string; duration?: number; sourcePath?: string; uploaded?: boolean; received?: number };

// Final Cut's caches and the Mac's own bookkeeping: never footage, and often most of a library's files.
const SKIP = new Set(['Render Files', 'Transcoded Media', 'Analysis Files', 'Peaks Data', 'Thumbnail Media', 'Shared Items', 'Backups', 'Backups.backupdb']);
const ENTRY_LIMIT = 300_000;
/**
 * Every file under the dropped entries whose name the project still needs (`wanted` holds nameKey(name)). Only those
 * are opened; folders are always walked, hidden items (a leading ".", including AppleDouble "._" files) and caches never.
 * A file that cannot be opened (a broken alias, an unplugged drive) is skipped. `onCount` hears about every 100 entries.
 */
export async function walk(entries: FileSystemEntry[], wanted: Set<string>, onCount: (entries: number) => void = () => {}): Promise<Found[]> {
  const found = new Map<string, File>();
  let count = 0;
  const visit = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (++count > ENTRY_LIMIT) throw new Error("That's a lot of files. Drag the folder your clips are in instead.");
    if (count % 100 === 0) onCount(count);
    if (entry.isDirectory) {
      // readEntries answers in batches (100 in Chrome) until an empty one.
      const reader = (entry as FileSystemDirectoryEntry).createReader(), next = () => new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail)).catch(() => []);
      for (let batch = await next(); batch.length; batch = await next())
        for (const child of batch) if (!child.name.startsWith('.') && !(child.isDirectory && SKIP.has(child.name))) await visit(child, `${path}/${child.name}`);
    } else if (wanted.has(nameKey(entry.name)) && !found.has(path)) {
      const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail)).catch(() => undefined);
      if (file) found.set(path, file);
    }
  };
  for (const entry of entries) await visit(entry, entry.name);
  onCount(count);
  return [...found].map(([path, file]) => ({ path, file }));
}

/** found (weak: only the file name agreed), ambiguous (the chooser picks one of `candidates`) or missing. */
export type Match = { id: string; state: 'found' | 'ambiguous' | 'missing'; found?: Found; weak?: boolean; candidates?: Found[] };
/**
 * Which found file is each source the server does not have yet: the one whose path agrees with the source's original
 * path in the most trailing folders. Two SD cards with the same DCIM layout are told apart by their volume name.
 */
export function matchSources(sources: Source[], found: Found[]): Match[] {
  const byName = new Map<string, Found[]>();
  for (const f of found) { const key = segs(f.path).at(-1) ?? ''; (byName.get(key) ?? byName.set(key, []).get(key)!).push(f); }
  return sources.filter(s => !s.uploaded).map((s): Match => {
    const path = segs(s.sourcePath ?? s.name), scored = (byName.get(nameKey(s.name)) ?? []).map(f => ({ f, score: suffix(path, segs(f.path)) }));
    const best = Math.max(0, ...scored.map(c => c.score)), top = scored.filter(c => c.score === best).map(c => c.f);
    if (!top.length) return { id: s.id, state: 'missing' };
    // The same size and date: copies of one file, so either will do.
    if (top.every(f => f.file.size === top[0].file.size && f.file.lastModified === top[0].file.lastModified)) return { id: s.id, state: 'found', found: top[0], ...(best <= 1 && { weak: true }) };
    return { id: s.id, state: 'ambiguous', candidates: top };
  });
}

/**
 * Where the Footage screen asks the person to look. `label` marks the names to show in bold with **; `path` is the
 * folder's full path (Copy location), `crumbs` its Finder breadcrumb, `sidebar` and `item` the Finder scene's names.
 */
export type Place = { kind: 'library' | 'drive' | 'folder'; label: string; hint: string; path: string; crumbs: string[]; sidebar: string; item: string; ids: string[] };
/**
 * The missing sources grouped by where they were: each Final Cut library, each drive (at the folder its files share),
 * and each folder at the top of a home folder (Desktop and Movies are two places). More than 6 places merge up to their
 * drive or top home folder. ponytail: more than 6 drives and top folders stay more than 6 rows; add an "other places" row if that happens.
 */
export function places(missing: Source[]): Place[] {
  const files = missing.filter(s => s.sourcePath).map(s => ({ id: s.id, dir: s.sourcePath!.split('/').filter(Boolean).slice(0, -1) }));
  const top = (dir: string[]) => dir.slice(0, dir[0] === 'Volumes' ? 2 : dir[0] === 'Users' ? 3 : 1);
  const group = (merge: boolean) => {
    const groups = new Map<string, { library: boolean; dirs: string[][]; ids: string[] }>();
    for (const f of files) {
      const at = merge ? -1 : f.dir.findIndex(name => /\.fcpbundle$/i.test(name)), library = at >= 0, base = library ? f.dir.slice(0, at + 1) : top(f.dir), key = `${library}:${base.join('/')}`;
      const g = groups.get(key) ?? groups.set(key, { library, dirs: [], ids: [] }).get(key)!;
      g.dirs.push(library ? base : f.dir); g.ids.push(f.id);
    }
    return [...groups.values()];
  };
  let groups = group(false);
  if (groups.length > 6) groups = group(true);
  const shared = (dirs: string[][]) => dirs.reduce((common, dir) => { let n = 0; while (n < common.length && common[n] === dir[n]) n++; return common.slice(0, n); });
  return groups.sort((a, b) => b.ids.length - a.ids.length).map(({ library, dirs, ids }): Place => {
    const dir = shared(dirs), path = `/${dir.join('/')}`, plain = (name: string) => name.replace(/\.fcpbundle$/i, ''), last = plain(dir.at(-1) ?? 'Macintosh HD');
    const drive = dir[0] === 'Volumes' && dir.length > 1 ? dir[1] : undefined, home = dir[0] === 'Users' && dir.length > 1 ? dir[1] : undefined;
    const crumbs = drive ? dir.slice(1).map(plain) : ['Macintosh HD', ...dir.map(plain)], folder = home ? dir[2] ?? home : drive ?? dir[0] ?? 'Macintosh HD';
    if (library) return { kind: 'library', label: `Your Final Cut library **${last}**`, hint: drive ? `on the drive ${drive}` : `in ${dir.at(-2) ?? 'Macintosh HD'}`, path, crumbs, sidebar: folder, item: last, ids };
    if (drive) return { kind: 'drive', label: dir.length === 2 ? `The drive **${drive}**` : `The folder **${last}** on the drive **${drive}**`, hint: 'plug it in first', path, crumbs, sidebar: drive, item: last, ids };
    const label = !home ? `The folder **${last}**` : dir.length === 2 ? `Your home folder **${home}**` : dir.length === 3 ? `Your **${last}**` : `The folder **${last}** in ${dir[2]}`;
    return { kind: 'folder', label, hint: '', path, crumbs, sidebar: folder, item: last, ids };
  });
}

/** ok, or why a matched file is left out (tooBig) or needs a second look; `seconds` is a different clip's own length. */
export type Check = { state: 'ok' | 'unreadable' | 'tooBig' | 'different'; seconds?: number };
/**
 * Before Start: the file opens (a broken link or unplugged drive fails here), fits under `maxBytes`, and video or audio
 * runs as long as the project says, within max(0.5 s, 1%). A length this browser cannot read counts as ok.
 */
export async function checkFile(file: File, kind: string | undefined, duration: number | undefined, maxBytes: number, measure = mediaDuration): Promise<Check> {
  try { await file.slice(0, 1).arrayBuffer(); } catch { return { state: 'unreadable' }; }
  if (file.size > maxBytes) return { state: 'tooBig' };
  if ((kind !== 'video' && kind !== 'audio') || !duration || duration <= 0) return { state: 'ok' };
  const seconds = await measure(file, kind);
  return seconds !== undefined && Math.abs(seconds - duration) > Math.max(.5, duration * .01) ? { state: 'different', seconds } : { state: 'ok' };
}
/** The file's own length as this browser reads it; undefined for codecs it cannot read (MXF, ProRes RAW) or after 5 s. */
function mediaDuration(file: File, kind: string) {
  const url = URL.createObjectURL(file), element = document.createElement(kind === 'audio' ? 'audio' : 'video');
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<number | undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), 5000);
    element.onloadedmetadata = () => resolve(Number.isFinite(element.duration) ? element.duration : undefined);
    element.onerror = () => resolve(undefined);
    element.preload = 'metadata'; element.src = url;
  }).finally(() => { clearTimeout(timer); element.removeAttribute('src'); element.load(); URL.revokeObjectURL(url); });
}

/**
 * Which missing title fonts each dropped font file supplies, by fcp.sh's rule: every family whose fontKey starts the
 * file name's (the server matches the uploaded name the same way). Upload each as POST /api/fonts?name=<name>.
 * `family` is a row's "Choose font file…": the file is that family whatever it is called.
 */
export function assignFonts(families: string[], files: File[], family?: string) {
  const uploads: { file: File; name: string; families: string[] }[] = [], unmatched: File[] = [];
  for (const file of files) {
    const name = file.name.replace(/\.[^.]+$/, ''), key = fontKey(name), covers = family ? [family] : families.filter(f => fontKey(f) && key.startsWith(fontKey(f)));
    if (covers.length) uploads.push({ file, name: family ?? name, families: covers }); else unmatched.push(file);
  }
  return { uploads, unmatched };
}

const PROBE = 2 * 1024 * 1024;
let block: Uint8Array<ArrayBuffer> | undefined;
/** Upload speed in bytes/s: one stream (`single`) and min(4, files) together (`parallel`), and the server's `room`. */
export type Speed = { single: number; parallel: number; room?: number; measured: boolean };
/**
 * Times this connection with throwaway 2 MiB posts: one stream for 2 s, then min(4, files) streams for 3.5 s. Each
 * stream's first answer is its warm-up (TLS, TCP slow start), so the rate counts what is acknowledged after it.
 * `onSample` hears the running rate for the gauge. A failed probe assumes school Wi-Fi: 1.5 MB/s, `measured: false`.
 */
export async function measureSpeed(files: number, { project, onSample = () => {}, phases = [2000, 3500] }: { project?: string; onSample?: (bytesPerSecond: number) => void; phases?: number[] } = {}): Promise<Speed> {
  if (!block) { block = new Uint8Array(PROBE); for (let i = 0; i < PROBE; i += 65536) crypto.getRandomValues(block.subarray(i, i + 65536)); }
  let room: number | undefined;
  const phase = async (streams: number, ms: number) => {
    const began = performance.now(), stop = AbortSignal.timeout(ms + 10_000), rates = Array<number>(streams).fill(0);
    await Promise.all(rates.map(async (_, i) => {
      let warm = 0, bytes = 0;
      while (performance.now() - began < ms) {
        const reply = await api<{ bytes: number; room: number }>(`/uploads/probe${project ? `?project=${encodeURIComponent(project)}` : ''}`, { method: 'POST', body: block, signal: stop }), now = performance.now();
        room = reply.room;
        // A link too slow for a second answer in time is timed by its warm-up.
        if (!warm) { warm = now; rates[i] = reply.bytes / (now - began) * 1000; } else { bytes += reply.bytes; rates[i] = bytes / (now - warm) * 1000; }
        onSample(rates.reduce((a, b) => a + b, 0));
      }
    }));
    return rates.reduce((a, b) => a + b, 0);
  };
  try {
    const single = await phase(1, phases[0]), parallel = await phase(Math.max(1, Math.min(4, files)), phases[1]);
    if (single > 0 && parallel > 0) return { single, parallel, room, measured: true };
  } catch { /* the fallback below */ }
  return { single: 1.5e6, parallel: 1.5e6, room, measured: false };
}

/**
 * Seconds to send files of these sizes `lanes` at a time, largest first, when one stream manages `single` bytes/s and
 * all of them together `parallel`: with k files going, each gets min(single, parallel / k). So one giant clip that ends
 * up alone is timed at a single stream's speed. ponytail: × 1.08 covers hashing, chunk gaps and each file's start; tune it on a real upload.
 */
export function estimateSeconds(sizes: number[], single: number, parallel: number, lanes: number) {
  if (!(single > 0 && parallel > 0)) return Infinity;
  const queue = sizes.filter(size => size > 0).sort((a, b) => b - a);
  let going: number[] = [], seconds = 0;
  while (queue.length || going.length) {
    while (going.length < Math.max(1, lanes) && queue.length) going.push(queue.shift()!);
    // Every file going moves at the same speed, so the smallest finishes first and the others lose as many bytes.
    const least = Math.min(...going);
    seconds += least / Math.min(single, parallel / going.length);
    going = going.map(left => left - least).filter(left => left > 0);
  }
  return seconds * 1.08;
}

/** How many files to send at once: each keeps at least 0.5 MB/s, so an 8 MiB chunk lands well inside its 60 s timeout. */
export const lanesFor = (parallel: number, files: number) => Math.max(1, Math.min(4, files, Math.floor(parallel / 5e5)));

/** "less than a minute", "about 14 minutes", "about 2 hours 10 minutes" (to the nearest 10 minutes past an hour and a half). */
export function friendlyDuration(seconds: number) {
  if (seconds < 45) return 'less than a minute';
  if (seconds < 5400) { const minutes = Math.round(seconds / 60); return `about ${minutes} minute${minutes === 1 ? '' : 's'}`; }
  const tens = Math.round(seconds / 600), hours = Math.floor(tens / 6), minutes = tens % 6 * 10;
  return `about ${hours} hour${hours === 1 ? '' : 's'}${minutes ? ` ${minutes} minutes` : ''}`;
}

/**
 * What a Projects card says about a Final Cut import (§8.2), or nothing once it has been done a day. `who` is the
 * importer's name, '' when it is the viewer; a bold name is wrapped in `**`. `ready` has no overlay: `title` is its chip and
 * `detail` the "needs attention" chip, if any. `label` is the same news for the card's aria-label.
 */
export function importCard(i: FcpImport, who: string, now = Date.now()) {
  if (i.phase === 'ready' && !(now - (i.doneAt ?? 0) < 86_400_000)) return undefined;
  const percent = i.total ? Math.floor(i.received * 100 / i.total) : 0, unit = i.total >= 1e9 ? 1e9 : 1e6;
  const left = i.rate > 0 ? ` · ${friendlyDuration((i.total - i.received) / i.rate).replace(/(\d) minutes?/, '$1 min')} left` : '';
  const card = (title: string, detail: string, progress: number | undefined, label: string) => ({ phase: i.phase, title, detail, progress, label });
  switch (i.phase) {
    case 'uploading': { const title = who ? `**${who}** is importing a project from Final Cut` : "You're importing a project from Final Cut"; return card(title, `${percent}% · ${(i.received / unit).toFixed(1)} of ${(i.total / unit).toFixed(1)} ${unit === 1e9 ? 'GB' : 'MB'}${left}`, percent, `${title.replaceAll('**', '')}, ${percent} percent`); }
    case 'paused': { const mac = who ? `${who}'s Mac` : 'your Mac'; return card(`Paused · waiting for ${mac}`, `${percent}%`, percent, `Import paused at ${percent} percent, waiting for ${mac}`); }
    case 'processing': return card('Getting it ready', `${i.ready} of ${i.files} clips ready`, i.files ? i.ready * 100 / i.files : 0, `Getting it ready, ${i.ready} of ${i.files} clips ready`);
    case 'stopped': return card(`Import stopped at ${percent}%`, `${who || 'You'} can finish it at sharedcut.com/importer`, undefined, `Import stopped at ${percent} percent`);
    default: { const attention = i.failed ? `${i.failed} clip${i.failed === 1 ? ' needs' : 's need'} attention` : ''; return card('New from Final Cut', attention, undefined, `New from Final Cut${attention ? `, ${attention}` : ''}`); }
  }
}
