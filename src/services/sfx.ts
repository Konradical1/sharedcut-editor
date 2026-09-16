export interface SoundEffect {
  id: string; name: string; category: string; tags: string[]; description: string;
  duration: number; waveform: number[]; waveformVersion?: number; status: 'preparing' | 'ready' | 'failed';
  error?: string; originalName?: string; source?: string; license?: string; addedBy?: string;
  url?: string;
}
export const soundCategories = ['Whooshes', 'Risers', 'Impacts', 'Glitches', 'UI & Beeps', 'Cameras', 'Everyday Sounds'];
export function soundFields(value: Record<string, unknown>) {
  const field = (key: string, max: number, required = true) => {
    const text = value[key];
    if (typeof text !== 'string' || text.length > max || (required && !text.trim()) || /[\x00-\x1f]/.test(text)) throw Object.assign(new Error(`Enter a valid ${key} (up to ${max} characters).`), { status: 400 });
    return text.trim();
  };
  if (!Array.isArray(value.tags) || value.tags.length > 20 || value.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 40 || /[\x00-\x1f]/.test(t))) throw Object.assign(new Error('Use up to 20 tags, each under 40 characters.'), { status: 400 });
  return { name: field('name', 80), category: field('category', 50), tags: [...new Set((value.tags as string[]).map(t => t.trim().toLowerCase()))], description: field('description', 500, false) };
}
export function soundText(sound: SoundEffect) { return `${sound.name}. ${sound.description}. ${sound.category}. ${sound.tags.join(', ')}`; }
export function rankSounds(sounds: SoundEffect[], query: string, similarities: number[] = []) {
  const q = query.trim().toLowerCase(), words = q.split(/\s+/);
  if (!q) return sounds;
  return sounds.map((sound, i) => {
    const name = sound.name.toLowerCase(), text = `${soundText(sound)} ${sound.originalName ?? ''}`.toLowerCase();
    const lexical = name === q ? 3 : name.includes(q) ? 2 : text.includes(q) ? 1.5 : words.every(w => text.includes(w)) ? 1 : 0;
    return { sound, score: lexical + (similarities[i] ?? 0), match: lexical > 0 || (similarities[i] ?? 0) >= .28 };
  }).filter(r => r.match).sort((a, b) => b.score - a.score || a.sound.name.localeCompare(b.sound.name)).map(r => r.sound);
}

export function availableSoundTrack(tracks: import('../state/models.ts').Track[], clips: import('../state/models.ts').Clip[], timelineId: string, start: number, duration: number) {
  return tracks.filter(t => t.timelineId === timelineId && t.kind === 'audio' && !t.locked && !t.captionSets)
    .sort((a, b) => a.number - b.number).find(t => !clips.some(c => c.trackId === t.id && c.start < start + duration && c.start + c.duration > start));
}
