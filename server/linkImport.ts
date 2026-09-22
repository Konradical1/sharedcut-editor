import { killProcessTree } from './processTree.ts';
import { venvPython } from './platform.ts';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export type ImportLink = { url: string; mode: 'video' | 'audio'; quality: 720 | 1080 | 2160 };
export function parseImportLink(value: unknown, mode: unknown = 'video', quality: unknown = 1080): ImportLink {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Paste a YouTube video or Spotify track link.');
  let url: URL; try { url = new URL(value.trim()); } catch { throw new Error('Paste a complete https:// link.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use an HTTPS link without credentials or a port.');
  if (!['video', 'audio'].includes(String(mode)) || ![720, 1080, 2160].includes(Number(quality))) throw new Error('Choose a supported import format and quality.');
  if (url.hostname === 'open.spotify.com') {
    const id = /^(?:\/intl-[a-z-]+)?\/track\/([a-zA-Z0-9]{22})\/?$/.exec(url.pathname)?.[1];
    if (!id) throw new Error('Use a single Spotify track link. Albums and playlists are not supported.');
    return { url: `https://open.spotify.com/track/${id}`, mode: 'audio', quality: Number(quality) as ImportLink['quality'] };
  }
  let id: string | undefined;
  if (url.hostname === 'youtu.be') id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') ?? undefined : /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) throw new Error('Use a single YouTube video or Spotify track link.');
  return { url: `https://www.youtube.com/watch?v=${id}`, mode: mode as ImportLink['mode'], quality: Number(quality) as ImportLink['quality'] };
}

export function youtubeThumbnail(url: string) {
  const canonical = parseImportLink(url).url;
  const id = new URL(canonical).searchParams.get('v');
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
}

export async function downloadLink(link: ImportLink, directory: string, maxBytes: number, signal: AbortSignal, onUpdate: (patch: { progress?: number; name?: string; thumbnail?: string; matchedSourceUrl?: string; matchedSourceTitle?: string }) => void) {
  // A retry discards partial downloads left by an interrupted server process.
  for (const name of readdirSync(directory).filter(name => name.startsWith('download-'))) await rm(join(directory, name), { recursive: true, force: true });
  const temporary = await mkdtemp(join(directory, 'download-'));
  try {
    const python = process.env.FRAME_LINE_IMPORT_PYTHON || venvPython('.venv-import');
    if (!existsSync(python)) throw new Error('Link importing needs setup on the server: run npm run setup:imports, then retry.');
    const result = await new Promise<{ filename: string; title: string }>((accept, reject) => {
      const child = spawn(python, [join(root, 'scripts/import-link.py'), link.url, link.mode, String(link.quality), temporary, String(maxBytes), process.execPath], { detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
      let buffer = '', stderr = '', failure: Error | undefined, result: { filename: string; title: string } | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (sig: NodeJS.Signals) => killProcessTree(child, sig);
      const stop = (message: string) => { if (failure) return; failure = new Error(message); kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 2000); };
      const abort = () => stop('Import cancelled.');
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      const timeout = setTimeout(() => stop('Import timed out after 30 minutes. Retry or import a shorter video.'), 30 * 60_000);
      const limit = setInterval(() => {
        try { if (readdirSync(temporary).reduce((sum, file) => sum + statSync(join(temporary, file)).size, 0) > maxBytes * 2) stop('Download exceeds the configured storage limit.'); } catch { /* Directory may be closing. */ }
      }, 500);
      child.stdout.on('data', chunk => {
        buffer += chunk.toString(); if (buffer.length > 64_000) { stop('Invalid downloader response.'); return; }
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'progress' && Number.isFinite(event.percent)) onUpdate({ progress: Math.max(0, Math.min(99, Math.floor(event.percent))) });
            if (event.type === 'source') onUpdate({ name: String(event.title).slice(0, 240), thumbnail: youtubeThumbnail(event.url), matchedSourceUrl: parseImportLink(event.url).url, matchedSourceTitle: String(event.matchedTitle).slice(0, 240) });
            if (event.type === 'complete') result = { filename: String(event.filename), title: String(event.title) };
            if (event.type === 'error') failure = new Error(String(event.message).slice(0, 1500));
          } catch { /* Third-party libraries may print diagnostic lines. */ }
        }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
      child.on('error', error => { failure = new Error(`Could not start link importer: ${error.message}`); });
      child.on('close', code => {
        clearTimeout(timeout); clearInterval(limit); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0 || !result) reject(new Error(stderr.trim() || 'No media was downloaded. The source may be unavailable.'));
        else accept(result);
      });
    });
    if (signal.aborted) throw new Error('Import cancelled.');
    if (basename(result.filename) !== result.filename || !/^media\.[a-z0-9]+$/.test(result.filename)) throw new Error('Invalid downloaded filename.');
    const file = join(temporary, result.filename), size = statSync(file).size;
    if (!size || size > maxBytes) throw new Error('Downloaded media is empty or exceeds the configured size limit.');
    await rename(file, join(directory, 'original'));
    return { name: `${result.title.replace(/[\x00-\x1f/\\]/g, '_').slice(0, 230)}.${result.filename.split('.').pop()}` };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
