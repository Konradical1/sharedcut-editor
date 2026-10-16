// What the model reads. Everything is terse text: an id prints as an @handle (8 characters of its uuid), a clip is
// one line, and only what differs from the defaults is shown. Handles go back in through resolveHandles.
import { defaultProperties } from '../src/state/demo.ts';
import { projectBins } from '../src/state/store.ts';
import type { EditorStore } from '../src/state/store.ts';
import type { Clip, Track } from '../src/state/models.ts';
import { isTitle, getText, textContent } from '../src/services/text.ts';
import { isShape } from '../src/services/shapes.ts';
import { isComposition } from '../src/services/compositions.ts';
import { isAdjustment } from '../src/services/adjustment.ts';
import { isCaption } from '../src/services/captions.ts';
import { transitionName, transitionDuration } from '../src/services/transitions.ts';
import { markersOf } from '../src/services/timeline.ts';
import { takesIndex } from '../src/services/shots.ts';
import type { PersistedState } from '../src/services/index.ts';

const COLLECTIONS = ['projects', 'media', 'timelines', 'tracks', 'clips', 'nodes', 'comments', 'snapshots', 'renderJobs', 'operations', 'users', 'scripts', 'scriptBlocks', 'shots', 'boardItems'] as const;

const LONG = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{16,}/i;
/** An id's uuid (or long hash) prints as its first 8 characters plus whatever follows it: `clip-3fa9c1d2-…` is
 *  `@3fa9c1d2`, a project's track `…-<uuid>-v3` is `@786fb0b9-v3`. A short id (a demo `c3`) prints whole. */
export function handle(id: string | undefined | null): string {
  if (!id) return '-';
  const long = LONG.exec(id);
  return '@' + (long ? long[0].slice(0, 8) + id.slice(long.index + long[0].length) : id);
}
export const isLongId = (value: string) => LONG.test(value);

/** Every id the model may name: top-level entities and the ones nested inside clips, tracks and timelines. */
function knownIds(s: EditorStore): string[] {
  const ids: string[] = [];
  for (const key of COLLECTIONS) for (const item of s[key] as { id: string }[]) ids.push(item.id);
  for (const clip of s.clips) {
    for (const effect of clip.effects) ids.push(effect.id);
    for (const mask of clip.smartMasks ?? []) ids.push(mask.id);
    for (const tracker of clip.motionTrackers ?? []) ids.push(tracker.id);
    if (typeof clip.properties.colorGroup === 'string') ids.push(clip.properties.colorGroup);
    for (const keys of Object.values(clip.keyframes ?? {})) for (const key of keys) ids.push(key.id);
  }
  for (const node of s.nodes) for (const effect of node.effects ?? []) ids.push(effect.id);
  for (const timeline of s.timelines) for (const marker of timeline.markers ?? []) if (marker.id) ids.push(marker.id);
  for (const track of s.tracks) for (const set of track.captionSets ?? []) ids.push(set.id);
  for (const project of s.projects) for (const bin of projectBins(project, s.media)) ids.push(bin.id);
  return ids;
}

/** Swap every string that is exactly an @handle (at any depth) for the full id it names. Other @words pass through as
 *  text ("@konrad" in a title stays "@konrad"), and "@@x" is the literal "@x". */
export function resolveHandles<T>(value: T, s: EditorStore): T {
  let byHandle: Map<string, string[]> | undefined;
  const one = (text: string) => {
    if (text.startsWith('@@')) return text.slice(1);
    if (!byHandle) { byHandle = new Map(); for (const id of knownIds(s)) for (const key of new Set([handle(id), `@${id}`])) byHandle.set(key, [...new Set([...(byHandle.get(key) ?? []), id])]); }
    const hits = byHandle.get(text) ?? [];
    if (hits.length > 1) throw new Error(`${text} is ambiguous: ${hits.slice(0, 4).join(', ')}. Pass the full id.`);
    // Shaped exactly like a handle (8 hex, maybe a suffix) yet naming nothing: a stale or mistyped id, not text.
    if (!hits.length && /^@[0-9a-f]{8}(?:-[\w-]+)?$/i.test(text)) throw new Error(`Nothing has the id ${text}. Look at the timeline or media list again.`);
    return hits[0] ?? text;
  };
  const walk = (v: unknown): unknown => typeof v === 'string' && /^@[@\w-]+$/.test(v) ? one(v)
    : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v;
  return walk(value) as T;
}
/** Like resolveHandles, but an id that names nothing is an error: for parameters that can only be ids. */
export function resolveId(text: string, s: EditorStore): string {
  const id = resolveHandles(text, s);
  if (id === text && text.startsWith('@')) throw new Error(`Nothing has the id ${text}. Look at the timeline or media list again.`);
  return id;
}

export const secs = (t: number) => Number.isFinite(t) ? String(Math.round(t * 1000) / 1000) : '?';
export function clock(t: number) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${(Math.round(s * 100) / 100).toFixed(2)}`;
}
export const quote = (text: string, max = 40) => JSON.stringify(text.length > max ? text.slice(0, max - 1) + '…' : text);
const ago = (ms: number) => { const m = Math.round((Date.now() - ms) / 60_000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

export function projectsView(s: EditorStore) {
  const role = (p: EditorStore['projects'][number]) => p.members.find(m => m.userId === s.currentUserId)?.role ?? (p.shared ? p.classRole ?? 'Viewer' : '?');
  const rows = [...s.projects].sort((a, b) => b.modifiedAt - a.modifiedAt).map(p => {
    const timelines = s.timelines.filter(t => t.projectId === p.id && !t.composition).length;
    const live = s.presence.filter(person => person.projectId === p.id && person.userId !== s.currentUserId).map(person => s.users.find(u => u.id === person.userId)?.name ?? person.userId);
    return `${p.id === s.projectId ? '*' : ' '}${handle(p.id)} ${quote(p.name)} ${p.resolution.replace(/ /g, '')} ${p.fps}fps ${role(p)} · ${p.status} · ${timelines} timeline${timelines === 1 ? '' : 's'} · ${ago(p.modifiedAt)} ago${live.length ? ` · editing now: ${live.join(', ')}` : ''}`;
  });
  return rows.length ? rows.join('\n') : 'No projects. Create one with act createProject.';
}

const ignored = new Set(['textDocument', 'shapeDocument', 'linkGroup', 'captionSet', 'compositionId', 'audioDetached', 'fadeOrigin', 'fadeDuration']);
function props(clip: Clip) {
  const out: string[] = [];
  for (const [key, value] of Object.entries(clip.properties)) {
    if (ignored.has(key) || /^(in|out)?[Tt]ransition/.test(key) || defaultProperties[key] === value) continue;
    if (key in defaultProperties || typeof value !== 'string' || value.length <= 24) out.push(`${key}=${typeof value === 'string' ? quote(value, 24) : value}`);
    else out.push(`${key}={…}`);
  }
  return out;
}
function kind(clip: Clip, s: EditorStore) {
  if (isCaption(clip)) return `CAPTION ${quote(textContent(getText(clip)), 50)}`;
  if (isTitle(clip)) return `TITLE ${quote(textContent(getText(clip)), 50)}`;
  if (isShape(clip)) { try { return `SHAPE ${JSON.parse(String(clip.properties.shapeDocument)).kind ?? ''}`.trim(); } catch { return 'SHAPE'; } }
  if (isComposition(clip)) return `COMP→${handle(String(clip.properties.compositionId))} ${quote(s.timelines.find(t => t.id === clip.properties.compositionId)?.name ?? '?')}`;
  if (isAdjustment(clip)) return 'ADJUSTMENT';
  const media = s.media.find(m => m.id === clip.mediaId);
  return `${quote(clip.name)} ←${handle(clip.mediaId)}${clip.sourceIn ? ` in ${secs(clip.sourceIn)}` : ''}${media && media.status !== 'ready' ? ` [media ${media.status}]` : ''}`;
}
export function clipLine(clip: Clip, s: EditorStore) {
  const parts = [`${handle(clip.id)} ${secs(clip.start)}–${secs(clip.start + clip.duration)} ${kind(clip, s)}`];
  const p = props(clip); if (p.length) parts.push(p.join(' '));
  if (clip.disabled) parts.push('DISABLED');
  if (clip.properties.linkGroup) parts.push(`link ${handle(String(clip.properties.linkGroup))}`);
  if (clip.effects.length) parts.push('fx ' + clip.effects.map(e => `${e.name}${e.enabled ? '' : '(off)'}${handle(e.id)}`).join(','));
  const kf = Object.keys(clip.keyframes ?? {}); if (kf.length) parts.push('kf ' + kf.join(','));
  const tr = (['in', 'out'] as const).filter(side => transitionName(clip, side)).map(side => `${side}:${transitionName(clip, side)} ${secs(transitionDuration(clip, side))}s`);
  if (tr.length) parts.push('tr ' + tr.join(' '));
  const nodes = s.nodes.filter(n => n.clipId === clip.id).length; if (nodes) parts.push(`grade ${nodes} nodes`);
  if (clip.smartMasks?.length) parts.push(`masks ${clip.smartMasks.length}`);
  if (clip.motionTrackers?.length) parts.push(`trackers ${clip.motionTrackers.length}`);
  return parts.join(' · ');
}
const trackName = (t: Track) => `${t.kind === 'video' ? 'V' : 'A'}${t.number}`;
export function timelineView(s: EditorStore, opts: { from?: number; to?: number; track?: string } = {}) {
  const timeline = s.timelines.find(t => t.id === s.timelineId);
  const project = s.projects.find(p => p.id === s.projectId);
  if (!timeline || !project) return 'No project open. Use projects {open:"name"}.';
  const clips = s.clips.filter(c => c.timelineId === timeline.id), end = Math.max(0, ...clips.map(c => c.start + c.duration));
  const others = s.timelines.filter(t => t.projectId === project.id && t.id !== timeline.id);
  const lines = [
    `${quote(project.name)} ${handle(project.id)} ${project.resolution.replace(/ /g, '')} ${project.fps}fps · timeline ${quote(timeline.name)} ${handle(timeline.id)}${timeline.composition ? ' (composition)' : ''} · edit ends ${clock(end)} · playhead ${secs(s.playhead)} · in/out ${secs(s.rangeIn)}–${secs(s.rangeOut)}${s.selectedClipIds.length ? ` · selected ${s.selectedClipIds.map(handle).join(',')}` : ''}`,
  ];
  if (others.length) lines.push('other timelines: ' + others.map(t => `${handle(t.id)} ${quote(t.name)}${t.composition ? '(comp)' : ''}`).join(', '));
  const markers = markersOf(timeline); if (markers.length) lines.push('markers: ' + markers.map(m => `${secs(m.time)} ${quote(m.name, 24)}${m.id ? handle(m.id) : ''}`).join(', '));
  const tracks = s.tracks.filter(t => t.timelineId === timeline.id).sort((a, b) => a.kind === b.kind ? b.number - a.number : a.kind === 'video' ? -1 : 1);
  const from = opts.from ?? -Infinity, to = opts.to ?? Infinity, want = opts.track?.toLowerCase();
  const picked = want ? tracks.filter(t => [t.id, handle(t.id), trackName(t), t.name].some(x => x.toLowerCase() === want)) : tracks;
  if (want && !picked.length) lines.push(`No track matches "${opts.track}"; tracks: ${tracks.map(t => `${trackName(t)} ${quote(t.name, 20)}`).join(', ')}`);
  for (const track of picked) {
    const flags = [track.hidden && 'hidden', track.locked && 'locked', track.muted && 'muted', track.solo && 'solo', track.gain && `gain ${track.gain}`, track.pan && `pan ${track.pan}`, track.captionSets?.length && `${track.captionSets.length} caption sets`].filter(Boolean);
    const own = clips.filter(c => c.trackId === track.id && c.start < to && c.start + c.duration > from).sort((a, b) => a.start - b.start);
    lines.push(`${trackName(track)} ${quote(track.name, 24)} ${handle(track.id)}${flags.length ? ' [' + flags.join(', ') + ']' : ''}${own.length ? '' : ' (empty)'}`);
    // Caption lines run to hundreds of one-word clips; list them only when this track is asked for.
    const captions = opts.track ? [] : own.filter(isCaption);
    if (captions.length > 3) {
      const sets = [...new Set(captions.map(c => String(c.properties.captionSet)))];
      lines.push(`  ${captions.length} caption lines ${secs(captions[0].start)}–${secs(Math.max(...captions.map(c => c.start + c.duration)))} in set ${sets.map(handle).join(',')} · timeline{track:"${trackName(track)}"} lists them`);
    }
    for (const clip of captions.length > 3 ? own.filter(c => !isCaption(c)) : own) lines.push('  ' + clipLine(clip, s));
  }
  return lines.join('\n');
}

export function mediaView(s: EditorStore, filter = '') {
  const project = s.projects.find(p => p.id === s.projectId);
  if (!project) return 'No project open.';
  const bins = projectBins(project, s.media), want = filter.toLowerCase();
  const items = s.media.filter(m => m.projectId === project.id && (!want || m.name.toLowerCase().includes(want) || m.binId === filter || handle(m.binId) === filter));
  // A take of a shot-list row (named for it or linked by hand) says which shot.
  const shots = s.shots.filter(x => x.projectId === project.id), takes = shots.length ? takesIndex(shots, s.media) : new Map<string, string>();
  const shotOf = (id: string) => { const shot = shots.find(x => x.id === takes.get(id)); return shot ? ` · shot ${shot.number} ${handle(shot.id)}` : ''; };
  const rows = items.map(m => `${handle(m.id)} ${m.kind} ${quote(m.name, 50)} ${clock(m.duration)}${m.kind !== 'audio' ? ` ${m.resolution.replace(/ /g, '')}` : ''}${m.fps ? ` ${m.fps}fps` : ''} bin:${handle(m.binId)}${m.status === 'ready' ? '' : ` [${m.status}${m.progress ? ` ${Math.round(m.progress)}%` : ''}${m.error ? `: ${m.error}` : ''}]`}${m.hasAudio === false && m.kind === 'video' ? ' no-audio' : ''}${m.camera ? ` · ${m.camera}` : ''}${shotOf(m.id)}`);
  return `bins: ${bins.map(b => `${handle(b.id)}(${quote(b.name, 20)})`).join(' ')}\n${rows.join('\n') || 'No media in this project.'}`;
}

/** One entity in full, with the bulky arrays (waveforms, LUT data) cut down unless `full`. */
export function entityView(id: string, s: EditorStore, path?: string, full = false) {
  let found: unknown, where = '';
  for (const key of COLLECTIONS) { const item = (s[key] as { id: string }[]).find(i => i.id === id); if (item) { found = item; where = key; break; } }
  if (!found) for (const clip of s.clips) {
    const nested = [...clip.effects, ...clip.smartMasks ?? [], ...clip.motionTrackers ?? []].find(i => i.id === id);
    if (nested) { found = nested; where = `in clip ${handle(clip.id)}`; break; }
  }
  if (!found) for (const node of s.nodes) { const effect = node.effects?.find(e => e.id === id); if (effect) { found = effect; where = `in grade node ${handle(node.id)}`; break; } }
  if (!found) for (const timeline of s.timelines) { const marker = timeline.markers?.find(m => m.id === id); if (marker) { found = marker; where = `marker on ${handle(timeline.id)}`; break; } }
  if (!found) throw new Error(`Nothing has the id ${handle(id)}.`);
  let value: unknown = structuredClone(found);
  // Documents are stored as JSON strings; show them as objects.
  const props = (value as Clip).properties;
  if (props) for (const key of ['textDocument', 'shapeDocument']) if (typeof props[key] === 'string') try { (props as Record<string, unknown>)[key] = JSON.parse(props[key] as string); } catch { /* leave it */ }
  if (path) value = path.split('.').reduce<unknown>((v, part) => (v as Record<string, unknown> | undefined)?.[part], value);
  const trim = (v: unknown): unknown => Array.isArray(v) ? (v.length > 24 && v.every(x => typeof x === 'number') ? `[${v.length} numbers]` : v.map(trim))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)])) : typeof v === 'string' && v.length > 400 ? `${v.slice(0, 200)}…(${v.length} chars)` : v;
  const handles = (_k: string, v: unknown) => typeof v === 'string' && isLongId(v) && !/\s/.test(v) ? handle(v) : v;
  return `${where}${path ? `.${path}` : ''}: ${JSON.stringify(full ? value : trim(value), handles)}`;
}

/** What one tool call changed, from the persisted state before and after. */
export function changeSummary(before: PersistedState, after: PersistedState, s: EditorStore, own?: Set<string>) {
  const lines: string[] = [];
  for (const key of ['projects', 'timelines', 'tracks', 'clips', 'nodes', 'comments', 'media', 'snapshots', 'renderJobs', 'scripts', 'scriptBlocks', 'shots', 'boardItems'] as const) {
    const was = new Map((before[key] as { id: string }[]).map(i => [i.id, i])), now = new Map((after[key] as { id: string }[]).map(i => [i.id, i]));
    const label = key === 'renderJobs' ? 'export' : key === 'scriptBlocks' ? 'script line' : key === 'boardItems' ? 'board card' : key.replace(/s$/, '');
    // What names it: a script line by kind and text, a shot by number, a card by kind and its text or color.
    const brief = (item: any) => key === 'scriptBlocks' ? `${item.kind.toUpperCase()} ${quote(item.text, 40)}` : key === 'shots' ? `${item.number}${item.text ? ` ${quote(item.text, 40)}` : ''}`
      : key === 'boardItems' ? `${item.kind}${item.text ? ` ${quote(item.text, 40)}` : item.color ? ` ${item.color}` : item.mediaId ? ` ${handle(item.mediaId)}` : ''}` : quote(item.name ?? item.text ?? '', 40);
    const line = (item: any) => {
      if (key !== 'clips') return `${handle(item.id)} ${brief(item)}`;
      const track = s.tracks.find(t => t.id === item.trackId);
      return `${track ? `${trackName(track)} ` : ''}${clipLine(item, s)}`;
    };
    for (const [id, item] of now) if (!was.has(id)) lines.push(`+ ${label} ${line(item)}`);
    for (const [id, item] of was) if (!now.has(id)) lines.push(`- ${label} ${handle(id)} ${brief(item)}`);
    for (const [id, item] of now) {
      const old = was.get(id) as Record<string, unknown> | undefined;
      if (!old || old === item || JSON.stringify(old) === JSON.stringify(item)) continue;
      const fields = diffFields(old, item as unknown as Record<string, unknown>);
      if (fields.length) lines.push(`~ ${label} ${handle(id)} ${fields.join(' ')}`);
    }
  }
  // Only this batch's own history rows: a collaborator's, merged in during the save, is not ours to report.
  const ops = after.operations.filter(op => own ? own.has(op.id) : !before.operations.some(o => o.id === op.id)).map(op => op.description);
  if (ops.length) lines.push(`history: ${ops.map(d => quote(d, 60)).join(', ')}`);
  const settings = Object.keys(after.settings).filter(k => JSON.stringify(after.settings[k]) !== JSON.stringify(before.settings[k]));
  if (settings.length) lines.push(`settings: ${settings.join(', ')}`);
  return lines;
}
function diffFields(a: Record<string, unknown>, b: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'modifiedAt' || JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    const x = a[key], y = b[key], name = prefix + key;
    const small = (v: unknown) => v === undefined || v === null || typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 30);
    if (small(x) && small(y)) out.push(`${name} ${x === undefined ? '∅' : typeof x === 'number' ? secs(x) : JSON.stringify(x)}→${y === undefined ? '∅' : typeof y === 'number' ? secs(y) : JSON.stringify(y)}`);
    else if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y) && !prefix) out.push(...diffFields(x as Record<string, unknown>, y as Record<string, unknown>, `${key}.`));
    else out.push(`${name} changed`);
  }
  return out.slice(0, 12);
}
