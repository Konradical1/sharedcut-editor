// sharedcut.com/download: which desktop installer to offer. The server publishes electron-builder's update manifests beside
// the installers at /download/<file>: latest-mac.yml (a universal .dmg, plus the .zip only the updater uses) and latest.yml
// (the Windows setup .exe). Pure functions, so the page and its test share them.

export type Platform = 'mac' | 'windows' | 'other';
/** A published installer. `url` is its download link, /download/<file>. */
export type Release = { version: string; url: string; size: number; releasedAt?: string };

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

/** The installer with this extension in a manifest, or null when there is none, or the text is not a manifest (a 404 page). */
export function parseRelease(yml: string, extension: '.dmg' | '.exe'): Release | null {
  const top: Record<string, string> = {}, files: Record<string, string>[] = [];
  // Flat YAML: top-level keys, and `files:` as a list of `- url:` items whose other keys are indented under them.
  for (const line of yml.split(/\r?\n/)) {
    const [, indent, item, key, value] = /^(\s*)(-\s+)?(\w+):(.*)$/.exec(line) ?? [];
    if (!key) continue;
    if (item) files.push({});
    if (indent || item) { const file = files.at(-1); if (file) file[key] = unquote(value); } else top[key] = unquote(value);
  }
  const file = files.find(f => f.url?.toLowerCase().endsWith(extension)), size = Number(file?.size);
  if (!top.version || !file || !(size > 0)) return null;
  return { version: top.version, url: `/download/${encodeURIComponent(file.url)}`, size, ...(top.releaseDate ? { releasedAt: top.releaseDate } : {}) };
}

/** Which installer to lead with. Phones and tablets are 'other': the app is desktop only. */
export function detectPlatform(userAgent: string, platform = '', touchPoints = 0): Platform {
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(userAgent)) return 'other';
  const os = /Windows|Mac/i.exec(userAgent)?.[0] ?? platform;
  if (/^win/i.test(os)) return 'windows';
  // An iPad asks for desktop sites as a Mac; only its touch screen gives it away.
  if (/^mac/i.test(os)) return touchPoints > 1 ? 'other' : 'mac';
  return 'other';
}
