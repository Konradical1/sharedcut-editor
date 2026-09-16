import { readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { soundLibrary } from '../server/sfx.ts';
const dataDir = resolve(process.env.FRAME_LINE_DATA || 'data');
const supplied = process.argv[2];
if (!supplied) throw new Error('Usage: node --experimental-strip-types scripts/import-sfx.mjs /path/to/supplied/sounds');
const catalog = JSON.parse(readFileSync(new URL('./sfx-catalog.json', import.meta.url), 'utf8'));
const library = soundLibrary(dataDir);
for (const entry of catalog) {
  if (library.list().some(s => s.originalName === entry.file && s.source === entry.source && s.status === 'ready')) continue;
  const input = entry.pack ? join(dataDir, 'sfx-sources', entry.pack, 'Audio', entry.file) : join(supplied, entry.file);
  if (!existsSync(input)) throw new Error(`Missing sound: ${input}`);
  const temp = join(dataDir, 'sfx-sources', 'import.wav');
  mkdirSync(join(dataDir, 'sfx-sources'), { recursive: true });
  try {
    if (entry.pack) execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-y', '-i', input, '-c:a', 'pcm_s24le', temp]);
    await library.add(entry.pack ? temp : input, entry, { originalName: entry.file, source: entry.source, license: entry.license });
    console.log(`Imported ${entry.name}`);
  } finally { rmSync(temp, { force: true }); }
}
console.log(`${library.list().filter(s => s.status === 'ready').length} sounds ready. Preparing semantic search…`);
const result = await library.search('a quick transition', '');
if (!result.semantic) throw new Error('Sounds imported, but semantic search setup failed. Re-run after fixing the model download.');
console.log('Semantic search ready:', result.sounds.slice(0, 5).map(s => s.name).join(', '));
