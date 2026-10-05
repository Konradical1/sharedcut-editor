// Shared libraries: sound effects, fonts, transition overlays (+ presets and favorites) and project folders. Each job
// calls the endpoint the editor's panel calls, with the same body; timeline edits go through the same store actions.
// Transition presets and favorites are plain store actions (act); the "library" help topic has the recipe.
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, resolve } from 'node:path';
import { call, refresh, edit, handle, need, clip, project, store, done, type JobDef, type Poller } from './kit.ts';
import { secs } from '../views.ts';
import { availableSoundTrack, soundCategories, soundFields, type SoundEffect } from '../../src/services/sfx.ts';
import type { AccessPreview, LibraryChange, LibraryView } from '../../src/services/library.ts';
import { effectDefinitions, loudnessTargets } from '../../src/services/effects.ts';
import { defaultTextEffects, defaultTextStyle, getText, isTitle, replaceText, styleText, textContent, type TextDocument, type TextStyle } from '../../src/services/text.ts';
import { boundedAnimationValue, evaluateClip } from '../../src/services/animation.ts';
import type { EditorStore } from '../../src/state/store.ts';
import type { MediaAsset } from '../../src/state/models.ts';

const q = JSON.stringify;
// Registered on the export canvas by server/captionRender.ts; any other family must be a shared font or installed on the server.
const BUNDLED_FONTS = ['TikTok Sans', 'Montserrat', 'Barlow Condensed'];
const STYLE_KEYS = Object.keys(defaultTextStyle), BOX_KEYS = ['x', 'y', 'width', 'height', 'align', 'lineHeight', 'opacity', ...Object.keys(defaultTextEffects)];
/** Unknown keys would be saved into the document silently; name the right bucket instead. */
function keys<T extends Record<string, any>>(value: T, allowed: string[], what: string): T {
  const bad = Object.keys(value).filter(k => !allowed.includes(k));
  if (bad.length) throw new Error(`${what} has no ${bad.join(', ')}. ${what} keys: ${allowed.join(', ')}${what === 'box' ? '; font keys go in style' : '; box/look keys go in box'}.`);
  return value;
}

/** A local file the model named: ~ and relative paths work, the size is checked before it is read. */
async function localFile(path: string, maxBytes: number, accept: RegExp, what: string) {
  const full = resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
  if (!accept.test(full)) throw new Error(`${basename(full)} is not ${what}.`);
  const info = await stat(full).catch(() => { throw new Error(`No file at ${full}.`); });
  if (info.size > maxBytes) throw new Error(`${basename(full)} is ${(info.size / 2 ** 20).toFixed(1)} MB; the limit is ${maxBytes / 2 ** 20} MB.`);
  return { name: basename(full, extname(full)), body: new Uint8Array(await readFile(full)) };
}
const upload = <T>(path: string, body: Uint8Array<ArrayBuffer>) => call<T>(path, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body });

/** Ids that are not editor entities print short (no @, so the job tool leaves them alone) and resolve by prefix or name. */
function pick<T extends { id: string; name: string }>(items: T[], ref: unknown, what: string, minPrefix: number): T {
  const want = String(ref ?? '').trim(), lower = want.toLowerCase();
  const exact = items.filter(i => i.id === want);
  const hits = exact.length ? exact : items.filter(i => (want.length >= minPrefix && i.id.startsWith(want)) || i.name.toLowerCase() === lower);
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `"${want}" matches ${hits.length} ${what}s; give more of the id.` : `No ${what} "${want}". List them again.`);
}

// ── Sound effects ────────────────────────────────────────────────────────────────────────────────────────────────
type SfxList = { sounds: SoundEffect[]; categories: string[]; semantic: boolean };
const sfxId = (id: string) => id.slice(0, 12);
const sfxLine = (s: SoundEffect) => `${sfxId(s.id)} ${q(s.name)} · ${s.category} · ${secs(s.duration)}s${s.tags.length ? ` · ${s.tags.slice(0, 5).join(',')}` : ''}${s.status === 'ready' ? '' : ` [${s.status}${s.error ? `: ${s.error}` : ''}]`}`;

/** A track by @handle (already a full id here) or by its timeline label, V2 / A1, in the open timeline. */
function trackRef(ref: unknown, s: EditorStore) {
  const want = String(ref), label = /^([AV])(\d+)$/i.exec(want);
  const track = s.tracks.find(t => t.id === want) ?? (label ? s.tracks.find(t => t.timelineId === s.timelineId && t.kind === (label[1].toUpperCase() === 'A' ? 'audio' : 'video') && t.number === Number(label[2])) : undefined);
  if (!track) throw new Error(`No track ${want} in the open timeline.`);
  if (track.kind !== 'audio') throw new Error(`${want} is a video track; sounds go on A tracks.`);
  return track.id;
}

// ── Project folders ──────────────────────────────────────────────────────────────────────────────────────────────
type Folder = LibraryView['folders'][number];
const folderId = (id: string) => id.slice(0, 15);
const library = () => call<LibraryView>('/library');
const folderRef = (view: LibraryView, ref: unknown) => ref === null || ref === undefined || ref === '' || ref === 'top' ? null : pick(view.folders, ref, 'folder', 11);
function membersOf(list: unknown, s: EditorStore) {
  if (!Array.isArray(list)) throw new Error('members must be [{user:"name or @handle", role:"Editor"|"Viewer"}].');
  return list.map((m: Record<string, unknown>) => {
    const ref = String(m.user ?? m.userId ?? m.name ?? '').toLowerCase();
    const user = s.users.find(u => u.id.toLowerCase() === ref || u.name.toLowerCase() === ref);
    if (!user) throw new Error(`No account "${ref}" on this server.`);
    if (user.id === s.currentUserId) throw new Error('members are other people; you already have access.');
    return { userId: user.id, role: m.role === 'Viewer' ? 'Viewer' as const : 'Editor' as const };
  });
}
/** What ProjectLibrary.tsx asks the user to confirm before it commits. */
function needsConfirm(change: LibraryChange, p: AccessPreview, view: LibraryView) {
  const lines = p.changes.map(c => `${q(c.name)}: ${[c.added.length && `gains ${c.added.join(', ')}`, c.removed.length && `loses ${c.removed.join(', ')}`, c.changed.length && `roles ${c.changed.join(', ')}`].filter(Boolean).join('; ')}`);
  if (p.classShared && (change.action === 'create' || change.action === 'move')) lines.push('shares the contents with everyone on the server (class)');
  if (change.action === 'delete') lines.push(`permanently deletes the empty folder ${q(view.folders.find(f => f.id === change.id)?.name ?? change.id)}`);
  return lines;
}

export const jobs: Record<string, JobDef> = {
  sfx: {
    doc: '{q?, category?, limit?} search the shared sound library → sfx-… ids',
    async start(params) {
      const text = String(params.q ?? ''), category = String(params.category ?? ''), limit = Number(params.limit) || 15;
      const data = await call<SfxList>(`/sfx?q=${encodeURIComponent(text)}&category=${encodeURIComponent(category)}`);
      const lines = data.sounds.slice(0, limit).map(sfxLine);
      if (data.sounds.length > limit) lines.push(`… ${data.sounds.length - limit} more (raise limit or narrow q)`);
      if (!lines.length) lines.push(text || category ? 'No sounds match.' : 'The sound library is empty. job sfx-save{clip} adds one.');
      lines.push(`categories: ${[...new Set([...soundCategories, ...data.categories])].join(', ')}${data.semantic ? '' : ' · (word match only: meaning search is unavailable)'}`);
      return done(lines.join('\n'));
    },
  },
  'sfx-add': {
    doc: '{sound, at?, track?} import a sound into the project and place it (first free audio track, playhead) → clip',
    async start(params) {
      const { sounds } = await call<SfxList>('/sfx');
      const sound = pick(sounds, need(params, 'sound'), 'sound', 8);
      if (sound.status !== 'ready') throw new Error(`${sound.name} is ${sound.status}${sound.error ? `: ${sound.error}` : ''}.`);
      const p = project(), at = params.at === undefined ? store.getState().playhead : need<number>(params, 'at', 'number');
      // src/services/sfxBrowser.ts insertSound, with the import landing through refresh (the server saved it) instead of receiveMedia.
      const { asset } = await call<{ asset: MediaAsset }>(`/sfx/${sound.id}/import`, { method: 'POST', json: { projectId: p.id } });
      const { text } = await edit(async run => {
        let trackId = params.track === undefined ? undefined : trackRef(params.track, store.getState());
        if (!trackId) {
          const from = Math.round(Math.max(0, at) * p.fps) / p.fps;
          const free = () => { const s = store.getState(); return availableSoundTrack(s.tracks, s.clips, s.timelineId, from, asset.duration)?.id; };
          trackId = free();
          if (!trackId) { await run('createTrack', 'audio'); trackId = free(); }
          if (!trackId) throw new Error('Add an unlocked audio track first.');
        }
        await run('addMediaToTimeline', asset.id, at, trackId);
      });
      return done(`${q(sound.name)} is media ${handle(asset.id)}\n${text}`);
    },
  },
  'sfx-save': {
    doc: '{clip, name?, category?, tags?, description?} bake an audio clip into the shared sound library → sfx-… id',
    async start(params) {
      const c = clip(need(params, 'clip'));
      const tags = typeof params.tags === 'string' ? params.tags.split(',').map(t => t.trim()).filter(Boolean) : params.tags ?? [];
      // SaveSoundEffect.tsx defaults: the clip's name, "Everyday Sounds", no description.
      const fields = soundFields({ name: params.name ?? c.name.replace(/\.[^.]+$/, '').slice(0, 80), category: params.category ?? 'Everyday Sounds', tags, description: params.description ?? '' });
      const { sound } = await call<{ sound: SoundEffect }>('/sfx', { method: 'POST', json: { projectId: c.projectId, clipId: c.id, ...fields } });
      const poller: Poller = {
        label: `saving ${q(sound.name)}`,
        async poll() {
          const now = (await call<SfxList>('/sfx')).sounds.find(s => s.id === sound.id);
          if (!now) throw new Error(`${sound.name} disappeared from the library.`);
          if (now.status === 'failed') throw new Error(`Could not save ${sound.name}: ${now.error ?? 'unknown error'}`);
          if (now.status === 'ready') return done(`saved ${sfxLine(now)} (shared with everyone on this server)`);
          return { done: false, text: `preparing ${q(sound.name)}…` };
        },
      };
      return poller;
    },
  },
  fonts: {
    doc: '{q?} shared fonts (fontFamily = FL-… id) + bundled families',
    async start(params) {
      const want = String(params.q ?? '').toLowerCase();
      const { fonts } = await call<{ fonts: { id: string; name: string; family: string }[] }>('/fonts');
      const rows = fonts.filter(f => !want || f.name.toLowerCase().includes(want)).map(f => `${f.family} ${q(f.name)}`);
      return done(`${rows.join('\n') || (want ? 'No shared font matches.' : 'No shared fonts yet. job font{path} adds one.')}\nbundled: ${BUNDLED_FONTS.join(', ')}\nUse: job text{clip, style:{fontFamily:"<FL-… id or bundled name>"}}`);
    },
  },
  font: {
    doc: '{path, name?} upload a TTF/OTF/TTC/WOFF/WOFF2 (≤15 MB) to the shared fonts → fontFamily',
    async start(params) {
      const file = await localFile(need(params, 'path'), 15 * 2 ** 20, /\.(ttf|otf|ttc|woff2?)$/i, 'a TTF, OTF, TTC, WOFF or WOFF2 font');
      const name = String(params.name ?? file.name).slice(0, 100);
      const { font } = await upload<{ font: { family: string; name: string } }>(`/fonts?name=${encodeURIComponent(name)}`, file.body);
      return done(`font ${q(font.name)} → fontFamily "${font.family}" (shared with everyone; fonts cannot be deleted)`);
    },
  },
  overlays: {
    doc: '{q?, limit?} shared overlays (Light leak params.leak ids), saved transition presets, your favorites',
    async start(params) {
      const want = String(params.q ?? '').toLowerCase(), limit = Number(params.limit) || 40;
      const data = await call<{ leaks: EditorStore['leaks']; presets: EditorStore['transitionPresets']; favorites: string[] }>('/transitions');
      // What loadLeaks installs: addTransition reads these for overlay timing and the shared defaults.
      store.setState({ leaks: data.leaks ?? [], transitionPresets: data.presets ?? [], transitionFavorites: data.favorites ?? [] });
      const me = store.getState().currentUserId;
      const leaks = data.leaks.filter(l => !want || `${l.id} ${l.name}`.toLowerCase().includes(want))
        .map(l => `${l.id} ${q(l.name)} ${secs(l.duration)}s${l.hasAudio ? ' sound' : ''}${data.favorites.includes(`overlay:${l.id}`) ? ' ★' : ''}${(l as { addedBy?: string }).addedBy === me ? ' (yours)' : ''}`);
      const presets = data.presets.filter(p => !want || p.id.toLowerCase().includes(want)).map(p => `${p.id} ${secs(p.duration)}s ${p.align}`);
      if (leaks.length > limit) leaks.splice(limit, Infinity, `… ${leaks.length - limit} more (narrow with q or raise limit)`);
      return done([`overlays: ${leaks.length ? '\n' + leaks.join('\n') : 'none'}`, `presets (defaults addTransition applies): ${presets.join(', ') || 'none'}`, `favorites: ${data.favorites.join(', ') || 'none'}`].join('\n'));
    },
  },
  overlay: {
    doc: '{path, name?} upload a ≤30 s video (≤64 MB) as a shared overlay · {delete:id} remove your own',
    async start(params) {
      if (params.delete !== undefined) {
        const { leaks } = await call<{ leaks: (EditorStore['leaks'][number] & { addedBy?: string })[] }>('/transitions');
        const leak = pick(leaks, params.delete, 'overlay', Infinity); // exact id or name: no prefix guesses for a delete
        // The server lets anyone delete the original pack (it has no uploader); here only your own uploads go.
        if (leak.addedBy !== store.getState().currentUserId) throw new Error(`${leak.id} is not your upload; only your own overlays can be deleted.`);
        await call(`/transitions/${encodeURIComponent(leak.id)}.mp4`, { method: 'DELETE' });
        store.setState({ leaks: store.getState().leaks.filter(l => l.id !== leak.id) });
        return done(`deleted overlay ${leak.id}`);
      }
      const file = await localFile(need(params, 'path'), 64 * 2 ** 20, /\.(mp4|mov|m4v|webm|mkv|avi)$/i, 'a video');
      const name = String(params.name ?? file.name).slice(0, 80);
      const { leak } = await upload<{ leak: EditorStore['leaks'][number] }>(`/transitions?name=${encodeURIComponent(name)}`, file.body);
      store.setState({ leaks: [...store.getState().leaks.filter(l => l.id !== leak.id), leak] });
      return done(`overlay ${leak.id} ${q(leak.name)} ${secs(leak.duration)}s${leak.hasAudio ? ' sound' : ''} → act addTransition(clip,"in","Light leak",{params:{leak:"${leak.id}"}})`);
    },
  },
  text: {
    doc: '{clip, text?, style?, range?:[start,end], box?, at?} set a title\'s words, style (only characters start–end with range) or box/look keys, keeping its animation; help text',
    async start(params) {
      const id = need(params, 'clip'), c = clip(id);
      if (!isTitle(c)) throw new Error(`${handle(id)} is not a title.`);
      if (params.at !== undefined) store.getState().setPlayhead(need<number>(params, 'at', 'number'));
      // updateText compares the doc with the title as drawn at the playhead (what TextInspector edits). The stored doc
      // that get shows is the un-animated base, so passing it back through act would key every animated channel.
      let doc: TextDocument = getText(evaluateClip(c, store.getState().playhead));
      if (params.text !== undefined) doc = replaceText(doc, String(params.text));
      const style = params.style === undefined ? undefined : keys(need<Partial<TextStyle>>(params, 'style', 'object'), STYLE_KEYS, 'style');
      const box = params.box === undefined ? undefined : keys(need<Partial<TextDocument>>(params, 'box', 'object'), BOX_KEYS, 'box');
      // A range styles only those characters of the (new) text, as selecting them in the Text inspector does.
      let range: { start: number; end: number } | undefined;
      if (params.range !== undefined) {
        const [start, end] = need<number[]>(params, 'range', 'array'), length = textContent(doc).length;
        if (!style) throw new Error('range needs style: it says which characters the style applies to.');
        if (![start, end].every(Number.isInteger) || start < 0 || end > length || start >= end) throw new Error(`range must be [start, end] character offsets with 0 ≤ start < end ≤ ${length}.`);
        range = { start, end };
      }
      if (style) doc = styleText(doc, style, range);
      if (box) doc = { ...doc, ...box, runs: doc.runs };
      const { text } = await edit(run => run('updateText', [{ id, doc }]));
      const family = String(style?.fontFamily ?? '');
      const warn = family && !BUNDLED_FONTS.includes(family) && !/^FL-[0-9a-f]{32}$/.test(family) ? `\nwarning: "${family}" is not a shared or bundled font; export fails unless the server has it installed (job fonts).` : '';
      return done(`${text}\n${handle(id)} ${q(textContent(doc))} ${doc.runs[0].style.fontFamily} ${doc.runs[0].style.fontSize}${warn}`);
    },
  },
  folders: {
    doc: '{} project folders as a tree (folder-… ids) with the projects in them',
    async start() {
      const view = await library(), s = store.getState(), ids = new Set(view.folders.map(f => f.id));
      // Class access comes from the strongest shared folder up the chain, not this folder's own (unused) classRole.
      const classRole = (f: Folder) => { const roles: string[] = []; for (let x: Folder | undefined = f, n = 0; x && n < 100; x = view.folders.find(p => p.id === x!.parentId), n++) if (x.shared) roles.push(x.classRole); return roles.includes('Editor') ? 'Editor' : roles[0] ?? ''; };
      const access = (f: Folder) => [f.classShared ? `class ${classRole(f)}`.trim() : f.effectiveMembers.length > 1 ? `${f.effectiveMembers.length} people` : 'only you', f.ownerId === s.currentUserId ? '' : `owner ${s.users.find(u => u.id === f.ownerId)?.name ?? '?'}`].filter(Boolean).join(', ');
      const projectsIn = (id: string | null) => s.projects.filter(p => id ? view.locations[p.id] === id : !ids.has(view.locations[p.id] ?? '')).sort((a, b) => a.name.localeCompare(b.name));
      const lines: string[] = [];
      const walk = (parent: string | null, depth: number) => {
        for (const f of view.folders.filter(f => parent ? f.parentId === parent : !ids.has(f.parentId ?? '')).sort((a, b) => a.name.localeCompare(b.name))) {
          lines.push(`${'  '.repeat(depth)}${folderId(f.id)} ${q(f.name)} (${access(f)})`);
          walk(f.id, depth + 1);
          for (const p of projectsIn(f.id)) lines.push(`${'  '.repeat(depth + 1)}${handle(p.id)} ${q(p.name)}`);
        }
      };
      walk(null, 0);
      const top = projectsIn(null);
      if (top.length) lines.push(`top level: ${top.map(p => `${handle(p.id)} ${q(p.name)}`).join(', ')}`);
      return done(lines.join('\n') || 'No folders or projects.');
    },
  },
  folder: {
    doc: '{action:create|update|move|delete, id?, name?, parent?, shared?, classRole?, members?, confirm?} change project folders; help library',
    async start(params) {
      const action = need(params, 'action'), view = await library(), s = store.getState();
      let change: LibraryChange, label: string;
      if (action === 'create') {
        const parent = folderRef(view, params.parent);
        change = { action, parentId: parent?.id ?? null, name: need(params, 'name'), shared: params.shared === true, classRole: params.classRole === 'Viewer' ? 'Viewer' : 'Editor', members: params.members === undefined ? [] : membersOf(params.members, s) };
        label = `created folder ${q(change.name!)}`;
      } else if (action === 'update') {
        // FolderForm sends every field; unnamed ones keep the folder's current values.
        const f = pick(view.folders, need(params, 'id'), 'folder', 11);
        change = { action, id: f.id, name: params.name ?? f.name, shared: params.shared ?? f.shared, classRole: params.classRole ?? f.classRole, members: params.members === undefined ? f.members : membersOf(params.members, s) };
        label = `updated ${folderId(f.id)} ${q(change.name!)}`;
      } else if (action === 'move') {
        const ref = need(params, 'id'), isProject = s.projects.some(p => p.id === ref);
        const target = isProject ? { id: ref, name: s.projects.find(p => p.id === ref)!.name } : pick(view.folders, ref, 'folder', 11);
        if (!('parent' in params)) throw new Error('params.parent is required: a folder id, or null for the top level.');
        const parent = folderRef(view, params.parent);
        change = { action, kind: isProject ? 'project' : 'folder', id: target.id, parentId: parent?.id ?? null };
        label = `moved ${q(target.name)} to ${parent ? q(parent.name) : 'the top level'}`;
      } else if (action === 'delete') {
        const f = pick(view.folders, need(params, 'id'), 'folder', 11);
        change = { action, id: f.id };
        label = `deleted folder ${q(f.name)}`;
      } else throw new Error('params.action must be create, update, move or delete.');
      // ProjectLibrary.tsx request(): preview, ask when access changes or on delete, then commit at the previewed revision.
      const { preview } = await call<{ preview: AccessPreview }>('/library', { method: 'POST', json: { ...change, preview: true } });
      const confirm = needsConfirm(change, preview, view);
      if (confirm.length && params.confirm !== true) return done(`Not done yet. This change:\n${confirm.join('\n')}\nRepeat with confirm:true to apply.`);
      const result = await call<LibraryView & { id?: string }>('/library', { method: 'POST', json: { ...change, revision: preview.revision } });
      await refresh();
      return done(`${label}${action === 'create' && result.id ? ` → ${folderId(result.id)}` : ''}`);
    },
  },
};

const range = (path: string) => `${boundedAnimationValue(path, -1e9)}–${boundedAnimationValue(path, 1e9)}`;
const lufs = loudnessTargets.map(t => `${t.lufs} ${t.label}`).join(', ');
const audioEffects = Object.entries(effectDefinitions).filter(([, d]) => d.kind !== 'video').map(([name]) => name).join(', ');

export const topics: Record<string, string> = {
  audio: [
    'audio: clip and track sound. All act; A tracks hold audio. Video files with sound come in as a linked video + audio clip pair: set sound on the audio clip.',
    `clip gain: updateProperty(clip,"gain",dB) -60–24 (keyframes ${range('properties.gain')}), default 0. pan: updateProperty(clip,"pan",-100 left … 100 right).`,
    'audio fades: updateProperty(clip,"audioFadeIn"|"audioFadeOut",seconds) 0–clip length. "fadeIn"/"fadeOut" are the picture fades (video/titles).',
    `normalize: updateProperty(clip,"normalize",true) then updateProperty(clip,"normalizeTarget",LUFS) with LUFS one of ${lufs}. Exact on export; the preview estimates it.`,
    'volume over time: setKeyframes(clip,"properties.gain",[{id:"g1",time:0,value:0,interpolation:"linear"},{id:"g2",time:2,value:-18,interpolation:"linear"}]) (time from the clip start; [] removes). Once keyed, updateProperty(clip,"gain",v) writes a key at the playhead: act{at, do}.',
    `ducking: key the music clip's gain down (-12 to -18) from just before to just after the voice, linear keys ~.3 s apart. pan keys work the same ("properties.pan", ${range('properties.pan')}).`,
    'mute one clip: updateProperty(clip,"disabled",true) or gain -60. Separate a pair first with unlinkClip(clip) to move or trim one side alone.',
    'track: updateTrack(track,{gain:-60–24, pan:-100–100, muted:true|false, solo:true|false}). The track must be in the open timeline (act{timeline}).',
    `audio effects: addEffect(clip,name) then updateEffect(clip,fxId,{parameters}) for ${audioEffects}; help effects filter <name> for parameters.`,
    'sound effects: job sfx{q} → job sfx-add{sound, at?, track?}; help library.',
  ].join('\n'),
  library: [
    'library: shared libraries (everyone on this server sees them) and project folders. Jobs unless act is named.',
    `sound effects: job sfx{q?, category?} meaning search (ids sfx-…). categories: ${soundCategories.join(', ')} + any typed when saving. sfx-add{sound, at?, track?} imports it into the project's media (once) and places it on the first free audio track at at (default playhead), adding a track if none is free. A named track ("A3") overwrites what is under the sound, like a drop.`,
    'save as sound effect: job sfx-save{clip, name, category, tags:"a, b"} bakes the clip\'s trim, gain, fades, audio effects and speed (not track gain/pan) into a new shared sound. Clip must be on an audio track, media ready, ≤10 min. Shared with everyone; no delete here.',
    `fonts: job fonts lists shared fonts; their fontFamily is the FL-… id. job font{path} uploads one for everyone (no delete). Bundled: ${BUNDLED_FONTS.join(', ')}. help text for using them.`,
    'overlays (light leaks, film burns): job overlays lists them + saved presets + your favorites; job overlay{path, name?} uploads a ≤30 s clip; overlay{delete:id} removes your own upload (refused while any clip, snapshot or deleted project uses it). Use: act [["loadLeaks"],["addTransition",clip,"in","Light leak",{params:{leak:"<id>"}}]]; loadLeaks first so the overlay\'s peak timing and the shared presets apply.',
    'transition preset: act saveTransitionPreset(clip,"in"|"out") makes that transition\'s current duration, align, curve and params the default for everyone (one per transition name, or per overlay). addTransition applies it unless you pass your own values.',
    'favorites (per user): act [["loadLeaks"],["toggleTransitionFavorite","transition:<Name>"|"overlay:<id>"]] toggles one. Not "transition:Light leak": favorite the overlay itself.',
    'folders: job folders shows the tree (folder-… ids, projects as @handles). job folder{action:"create", name, parent?, shared?, classRole?, members?} · {action:"update", id, name?, shared?, classRole?, members?} (unnamed fields stay) · {action:"move", id:folder or @project, parent:folder|null} · {action:"delete", id} (empty folders only).',
    'folder access: projects inherit their folder\'s access. shared:true + classRole "Editor"|"Viewer" opens it to everyone (class); members [{user:"name|@handle", role:"Editor"|"Viewer"}], never yourself. Only the owner changes, moves or deletes a folder; only a project\'s owner moves it. A change that alters who can open what (and every delete) is previewed: repeat with confirm:true.',
  ].join('\n'),
  text: [
    'text: change a title\'s words and look (TITLE "…" clips). New titles: help titles.',
    'words: job text{clip, text:"NEW LINE 1\\nLINE 2"} keeps each word\'s style where it can. style: job text{clip, style:{fontFamily, fontSize, color, …}} (only keys you change); box/look: job text{clip, box:{x, y, align, outlineWidth, …}}. One call can do all three.',
    'same in act (titles on the open timeline): [["selectText","@clip"],["formatText",{fontSize:120}]] styles the whole clip; more selectText steps with additive true add clips. Do not pass a doc from get to updateText on an animated title (kf text.*): it keys those channels at the playhead.',
    `style keys: fontFamily, fontSize ${range('text.fontSize')}, fontWeight ${range('text.fontWeight')}, letterSpacing ${range('text.letterSpacing')}, color "#rrggbb", italic/underline true|false. Defaults ${q(defaultTextStyle)}.`,
    `box/look keys: x,y = top-left of the box as a fraction of the frame (${range('text.x')}), width,height ${range('text.width')}, align left|center|right, lineHeight ${range('text.lineHeight')}, opacity 0–100; effects (defaults) ${q(defaultTextEffects)}.`,
    `fonts: export draws text on the server, so a family it lacks fails the export. Safe: ${BUNDLED_FONTS.join(', ')} or a shared font\'s FL-… id (job fonts; job font{path} adds one). Other names may only look right in the editor.`,
    'keyframed text: a changed channel that has keys gets a key at the playhead (job text{at} or act{at}); unkeyed channels change for the whole clip.',
    'layered presets make a composition: the timeline shows COMP→@timeline; its text clips live on that timeline (timeline{timeline:"@…"} lists them). job text works on them directly; formatText needs act{timeline:"@…"}.',
  ].join('\n'),
};
