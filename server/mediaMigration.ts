// Media storage v3 migration (docs/superpowers/specs/2026-10-03-media-storage-design.md): moves an asset prepared by an
// older build onto full-v3 + stream-v2 + stream-low-v2, then deletes the files that set replaces. One asset per call; the
// server runs these one at a time on its media queue at startup. Every step is safe to kill: output is written to a
// temp folder (swept at the next start), renamed into place only once verified, and old files go only after the row
// has been saved pointing at the new ones. A re-run picks up wherever the last one stopped.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaAsset } from '../src/state/models.ts';
import { AUDIO_VARIANT, FULL_VARIANT, STREAM_LOW_VARIANT, STREAM_VARIANT, SUPERSEDED_PREVIEWS, encodePreviews, probeMedia, run, type PreviewOutput } from './media.ts';

const fileOf = (url?: string) => url?.split('?')[0].split('/').at(-1);
const urls = (asset: MediaAsset) => [asset.proxyUrl, asset.colorProxyUrl, asset.audioProxyUrl, asset.thumbnail, asset.filmstrip, ...Object.values(asset.proxyVariants ?? {})];
/** Old preview files beside this asset that its row no longer names. A graphic only ever had the opaque pair. */
const leftovers = (asset: MediaAsset, prepared: string) => {
  const used = new Set(urls(asset).map(fileOf));
  return (asset.hasAlpha ? ['proxy.mp4', 'color-v1.mp4'] : SUPERSEDED_PREVIEWS).filter(name => !used.has(name) && existsSync(join(prepared, name)));
};
/** The row names the v3 set and every file it names is on disk. */
const current = (asset: MediaAsset, prepared: string) => {
  const v = asset.proxyVariants ?? {};
  return fileOf(asset.proxyUrl) === FULL_VARIANT && fileOf(asset.colorProxyUrl) === FULL_VARIANT && fileOf(v.Stream) === STREAM_VARIANT && fileOf(v['1/2']) === STREAM_VARIANT
    && fileOf(v.StreamLow) === STREAM_LOW_VARIANT && fileOf(v['1/4']) === STREAM_LOW_VARIANT && (asset.hasAudio ? fileOf(asset.audioProxyUrl) === AUDIO_VARIANT : !asset.audioProxyUrl)
    && [FULL_VARIANT, STREAM_VARIANT, STREAM_LOW_VARIANT, ...asset.hasAudio ? [AUDIO_VARIANT] : []].every(name => existsSync(join(prepared, name)));
};

/** Whether a ready video still owes the migration something: a new file set, a missing file rebuilt, or old files deleted. */
export function needsMigration(asset: MediaAsset, prepared: string) {
  if (asset.kind !== 'video' || asset.status !== 'ready') return false;
  if (asset.hasAlpha) return Boolean(asset.colorProxyUrl) || leftovers(asset, prepared).length > 0;
  return !current(asset, prepared) || leftovers(asset, prepared).length > 0;
}

/**
 * Deletes what `leftovers` names and returns the bytes freed. FFmpeg opens files without delete sharing, so Windows
 * refuses while one reads them: rm retries, and a file still held stays for the next start's pass.
 */
export async function removeLeftovers(asset: MediaAsset, prepared: string) {
  let freed = 0;
  for (const name of leftovers(asset, prepared)) {
    const file = join(prepared, name);
    try { const { size } = await stat(file); await rm(file, { force: true, maxRetries: 5, retryDelay: 200 }); freed += size; }
    catch (error) { console.error(`${asset.name}: ${name} is in use and stays until the next start.`, error); }
  }
  return freed;
}

/** A hard kill mid-encode leaves FFmpeg's temp folder in prepared/. Only media/<id>/prepared is looked at, never transitions or sfx. */
export function sweepPreparedTemp(mediaRoot: string, olderThan = Date.now() - 3600_000) {
  const list = (dir: string) => { try { return readdirSync(dir); } catch { return []; } };
  let removed = 0;
  for (const id of list(mediaRoot)) {
    const prepared = join(mediaRoot, id, 'prepared');
    // hdr-*.cube: the tone-mapping table older builds wrote next to the proxy; it is rebuilt in each temp folder now.
    for (const name of list(prepared)) if (/^\.(preview|color|thumbnail|filmstrip)-/.test(name) || /^hdr-.*\.cube$/.test(name)) {
      const path = join(prepared, name);
      try {
        // A folder's own time moves only when entries come and go; a file still growing inside it means an encode is alive.
        const touched = Math.max(statSync(path).mtimeMs, ...list(path).map(entry => statSync(join(path, entry)).mtimeMs));
        if (touched < olderThan) { rmSync(path, { recursive: true, force: true, maxRetries: 3 }); removed++; }
      } catch (error) { console.error(`Could not remove the interrupted preview folder ${path}:`, error); }
    }
  }
  return removed;
}

type Inspected = { duration: number; pixFmt?: string; width?: number; height?: number; video: boolean; audio: boolean };
async function inspect(file: string): Promise<Inspected> {
  const data = JSON.parse((await run(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file])).toString()) as { streams: { codec_type: string; duration?: string; pix_fmt?: string; width?: number; height?: number; disposition?: { attached_pic?: number } }[]; format: { duration?: string } };
  const video = data.streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  return { duration: Number(video?.duration ?? data.format.duration), pixFmt: video?.pix_fmt, width: video?.width, height: video?.height, video: Boolean(video), audio: data.streams.some(s => s.codec_type === 'audio') };
}
/** Why `file` is not the output asked for, or undefined when it is. */
async function problem(file: string, want: { duration: number; fps: number; audio: boolean; pixFmt?: string; width?: number; height?: number }) {
  if (!existsSync(file)) return 'missing';
  const got = await inspect(file).catch(error => error as Error);
  if (got instanceof Error) return `unreadable (${got.message.slice(0, 200)})`;
  if (want.audio && !got.audio) return 'no audio';
  if (want.pixFmt === undefined) return undefined;
  if (!got.video) return 'no video';
  if (got.pixFmt !== want.pixFmt) return `pixel format ${got.pixFmt}, wanted ${want.pixFmt}`;
  if (got.width !== want.width || Math.abs(got.height! - want.height!) > 2) return `size ${got.width}×${got.height}, wanted ${want.width}×${want.height}`;
  if (!(Math.abs(got.duration - want.duration) <= 1 / want.fps + .002)) return `duration ${got.duration}s, wanted ${want.duration}s`;
  return undefined;
}

async function moveIntoPlace(from: string, to: string) {
  // Renaming over a file another process holds open fails on Windows until it lets go.
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); }
    catch (error) { if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await new Promise(r => setTimeout(r, 200 * (attempt + 1))); }
  }
}

export type MigrationResult = { status: 'migrated' | 'cleaned' | 'current' | 'low-disk' | 'no-source'; freed: number };
/**
 * Brings one asset onto the v3 set. `update` saves a patch to the asset's row (the workspace store, never raw SQL) and
 * must throw if it cannot. `fromOriginal` rebuilds full-v3 and stream-low-v2 from the camera original even when they
 * exist (a corrected colour matrix); otherwise an old color-v1 is the source, being the original already converted.
 */
export async function migrateAsset(asset: MediaAsset, options: { mediaDir: string; baseUrl: string; version?: string; freeBytes: () => number; update: (patch: Partial<MediaAsset>) => void; signal?: AbortSignal; fromOriginal?: boolean }): Promise<MigrationResult> {
  const prepared = join(options.mediaDir, 'prepared'), original = join(options.mediaDir, 'original'), at = (name: string) => join(prepared, name);
  if (asset.hasAlpha) {
    // The alpha WebMs are its previews; an older opaque proxy and grading proxy would put the graphic on black.
    const cleaned = { ...asset, colorProxyUrl: undefined };
    if (asset.colorProxyUrl) options.update({ colorProxyUrl: undefined });
    return { status: 'cleaned', freed: await removeLeftovers(cleaned, prepared) };
  }
  if (!options.fromOriginal && current(asset, prepared)) { const freed = await removeLeftovers(asset, prepared); return { status: freed ? 'cleaned' : 'current', freed }; }

  const graded = !options.fromOriginal && existsSync(at('color-v1.mp4')) ? at('color-v1.mp4') : undefined;
  const source = graded ?? (existsSync(original) ? original : undefined);
  if (!source) return { status: 'no-source', freed: 0 };
  const probed = await probeMedia(source, options.signal), sourceDuration = (await inspect(source)).duration || probed.duration;
  const fps = probed.fps || asset.fps || 24, sizeAt = (max: number) => { const width = Math.min(max, probed.width ?? max); return { width, height: Math.round((probed.height ?? 0) * width / (probed.width || 1)) }; };
  const picture = (pixFmt: string, max: number) => ({ duration: sourceDuration, fps, audio: Boolean(asset.hasAudio), pixFmt, ...sizeAt(max) });
  const want = { full: picture('yuv422p10le', 1920), stream: picture('yuv420p', 960), low: picture('yuv420p', 480), audio: { duration: sourceDuration, fps, audio: true } };
  const names = { full: FULL_VARIANT, stream: STREAM_VARIANT, low: STREAM_LOW_VARIANT, audio: AUDIO_VARIANT };
  // A file a killed run already renamed into place is kept once it verifies. stream-v2 keeps its name, recipe and every
  // cached copy, so only a missing one is made again.
  const need = {
    full: options.fromOriginal || Boolean(await problem(at(FULL_VARIANT), want.full)),
    low: options.fromOriginal || Boolean(await problem(at(STREAM_LOW_VARIANT), want.low)),
    stream: !existsSync(at(STREAM_VARIANT)),
    audio: Boolean(asset.hasAudio) && !existsSync(at(AUDIO_VARIANT)),
  };
  const outputs = (Object.keys(need) as PreviewOutput[]).filter(output => need[output]);
  // With full-v3 already in place the smaller files come from it, as they do for a new upload. Sound comes from the AAC
  // audio-v1 (copied), else full-v3's own, else the original (encoded, since camera sound can be PCM).
  const video = need.full ? source : at(FULL_VARIANT);
  const audio = asset.hasAudio ? [at(AUDIO_VARIANT), ...video === at(FULL_VARIANT) ? [video] : [], original].find(file => existsSync(file)) : undefined;
  if (asset.hasAudio && !audio) return { status: 'no-source', freed: 0 };
  // ponytail: worst-case rates (4K60 log measured 11.5 Mbit/s for full-v3); measure the source if this refuses too often.
  const estimate = sourceDuration * ((need.full ? 16 : 0) + (need.low ? 1 : 0) + (need.stream ? 5 : 0) + (need.audio ? .2 : 0)) * 125_000;
  if (outputs.length && options.freeBytes() < estimate + 2 ** 30) return { status: 'low-disk', freed: 0 };

  if (outputs.length) {
    const temp = await mkdtemp(join(prepared, '.preview-'));
    try {
      await encodePreviews({ video, prepared: video !== original, audio, audioCopy: audio !== original, metadata: probed, outputs, temp, signal: options.signal });
      for (const output of outputs) { const wrong = await problem(join(temp, names[output]), want[output]); if (wrong) throw new Error(`${names[output]} failed verification: ${wrong}.`); }
      for (const output of outputs) await moveIntoPlace(join(temp, names[output]), at(names[output]));
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  // Prepared files are served immutable and footage caches key on the URL, so anything encoded here gets a URL no
  // browser has seen. A file left alone keeps the URL the row already had (stream-v2's cached copies stay valid).
  const stamp = `?v=${Date.now().toString(36)}`, encoded = new Set(outputs.map(output => names[output]));
  const url = (name: string) => encoded.has(name) ? `${options.baseUrl}/${name}${stamp}` : urls(asset).find(old => fileOf(old) === name && old!.startsWith(`${options.baseUrl}/`)) ?? `${options.baseUrl}/${name}${options.version ?? ''}`;
  const patch: Partial<MediaAsset> = { proxyUrl: url(FULL_VARIANT), colorProxyUrl: url(FULL_VARIANT), proxyVariants: { Stream: url(STREAM_VARIANT), '1/2': url(STREAM_VARIANT), StreamLow: url(STREAM_LOW_VARIANT), '1/4': url(STREAM_LOW_VARIANT) }, audioProxyUrl: asset.hasAudio ? url(AUDIO_VARIANT) : undefined };
  options.update(patch);
  return { status: 'migrated', freed: await removeLeftovers({ ...asset, ...patch }, prepared) };
}
