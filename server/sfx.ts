import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prepareMedia, prepareWaveform } from './media.ts';
import { rankSounds, soundFields, soundText, type SoundEffect } from '../src/services/sfx.ts';
import type { MediaAsset } from '../src/state/models.ts';

type Entry = SoundEffect & { metadata?: Awaited<ReturnType<typeof prepareMedia>> };
export function soundLibrary(dataDir: string) {
  const dir = join(dataDir, 'sfx'), manifest = join(dir, 'manifest.json');
  mkdirSync(dir, { recursive: true });
  const read = (): Entry[] => existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).sounds : [];
  const write = (sounds: Entry[]) => { writeFileSync(`${manifest}.tmp`, JSON.stringify({ version: 1, sounds }, null, 2)); renameSync(`${manifest}.tmp`, manifest); };
  const update = (id: string, patch: Partial<Entry>) => write(read().map(s => s.id === id ? { ...s, ...patch } : s));
  const get = (id: string) => read().find(s => s.id === id);
  const view = (entry: Entry): SoundEffect => { const { metadata, ...sound } = entry; return { ...sound, ...(sound.status === 'ready' ? { url: `/api/sfx/${sound.id}/preview` } : {}) }; };
  const file = (id: string, preview = false) => { const sound = get(id); return sound?.status === 'ready' ? join(dir, sound.id, preview ? 'audio.m4a' : 'original') : null; };
  const reserve = (fields: Record<string, unknown>, provenance: Partial<Pick<Entry, 'originalName' | 'source' | 'license' | 'addedBy'>> = {}) => {
    if (read().length >= 1000) throw Object.assign(new Error('The sound library is full (1,000 sounds).'), { status: 409 });
    const sound: Entry = { ...soundFields(fields), ...provenance, id: `sfx-${randomUUID()}`, duration: 0, waveform: [], status: 'preparing' };
    mkdirSync(join(dir, sound.id)); write([...read(), sound]); return view(sound);
  };
  const complete = async (id: string, inputPath: string, signal?: AbortSignal) => {
    const folder = join(dir, id);
    try {
      cpSync(inputPath, join(folder, 'original'));
      const metadata = await prepareMedia({ inputPath: join(folder, 'original'), outputDir: folder, baseUrl: `/api/sfx/${id}`, signal });
      if (!metadata.hasAudio) throw new Error('This file has no audio.');
      update(id, { metadata, duration: metadata.duration, waveform: metadata.waveform, waveformVersion: metadata.waveformVersion, status: 'ready', error: undefined });
    } catch (error) { update(id, { status: 'failed', error: error instanceof Error ? error.message : 'Sound preparation failed.' }); rmSync(folder, { recursive: true, force: true }); throw error; }
  };
  // One small CPU model per server; vectors are cached by description, never audio contents.
  let encoder: Promise<any> | undefined;
  const vectors = new Map<string, number[]>();
  const cache = join(dir, 'embeddings.json');
  try { for (const [key, value] of Object.entries(JSON.parse(readFileSync(cache, 'utf8')))) if (Array.isArray(value) && value.length === 384 && value.every(Number.isFinite)) vectors.set(key, value); } catch { /* Rebuild missing or stale search cache. */ }
  const embed = async (texts: string[]) => {
    const keys = texts.map(t => createHash('sha256').update(t).digest('hex'));
    const missing = [...new Map(texts.flatMap((t, i) => vectors.has(keys[i]) ? [] : [[keys[i], t] as const])).entries()];
    if (missing.length) {
      encoder ??= import('@huggingface/transformers').then(async ({ pipeline, env }) => { env.cacheDir = join(dir, 'models'); return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' }); }).catch(e => { encoder = undefined; throw e; });
      const model = await encoder;
      for (let offset = 0; offset < missing.length; offset += 32) {
        const batch = missing.slice(offset, offset + 32);
        const result = (await model(batch.map(([, text]) => text), { pooling: 'mean', normalize: true })).tolist() as number[][];
        batch.forEach(([key], i) => vectors.set(key, result[i]));
      }
      writeFileSync(`${cache}.tmp`, JSON.stringify(Object.fromEntries(vectors))); renameSync(`${cache}.tmp`, cache);
    }
    const result = keys.map(k => vectors.get(k)!);
    // ponytail: FIFO cache for a small catalog; use an LRU if repeat queries churn at larger scale.
    while (vectors.size > 2500) vectors.delete(vectors.keys().next().value!);
    return result;
  };
  let searchQueue: Promise<unknown> = Promise.resolve();
  const search = (query: string, category: string) => {
    const task = searchQueue.then(async () => {
      const all = read().map(view).sort((a, b) => a.name.localeCompare(b.name));
      const candidates = all.filter(s => !category || s.category === category);
      let similarities: number[] = [], semantic = !query.trim();
      if (query.trim()) try {
        const [q, ...rows] = await embed([query, ...candidates.map(soundText)]);
        similarities = rows.map(v => v.reduce((sum, n, i) => sum + n * q[i], 0)); semantic = true;
      } catch (error) { console.error('SFX semantic search:', error instanceof Error ? error.message : error); }
      return { sounds: rankSounds(candidates, query, similarities), categories: [...new Set(all.map(s => s.category))].sort(), semantic };
    });
    searchQueue = task.catch(() => {}); return task;
  };
  const upgradeWaveform = async (id: string, signal?: AbortSignal) => {
    const sound = get(id), input = file(id);
    if (!sound?.metadata || !input) return;
    const peaks = await prepareWaveform(input, sound.duration, signal);
    update(id, { ...peaks, metadata: { ...sound.metadata, ...peaks } });
  };
  return { upgradeWaveform, list: () => read().map(view), get, file, reserve, complete, search,
    fail: (id: string, error: unknown) => { update(id, { status: 'failed', error: error instanceof Error ? error.message : String(error) }); rmSync(join(dir, id), { recursive: true, force: true }); },
    recover: () => { for (const s of read()) if (s.status === 'preparing') { update(s.id, { status: 'failed', error: 'Preparation interrupted by a server restart. Save the sound again.' }); rmSync(join(dir, s.id), { recursive: true, force: true }); } },
    async add(input: string, fields: Record<string, unknown>, provenance = {}) { const sound = reserve(fields, provenance); await complete(sound.id, input); return get(sound.id)!; },
    importAsset(id: string, projectId: string, mediaId: string, target: string): MediaAsset {
      const sound = get(id); if (!sound?.metadata || sound.status !== 'ready') throw Object.assign(new Error('Sound is not ready.'), { status: 409 });
      mkdirSync(join(target, 'prepared'), { recursive: true });
      cpSync(join(dir, id, 'original'), join(target, 'original'));
      cpSync(join(dir, id, 'audio.m4a'), join(target, 'prepared', 'audio.m4a'));
      return { ...sound.metadata, id: mediaId, projectId, name: `${sound.name}.wav`, kind: 'audio', binId: 'audio', thumbnail: '', size: String(sound.metadata.size), status: 'ready', progress: 100, sourceUrl: `/api/media/${mediaId}/original`, proxyUrl: `/api/media/${mediaId}/files/audio.m4a` };
    },
  };
}
