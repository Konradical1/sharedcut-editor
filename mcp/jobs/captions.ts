// Captions: the server transcription job (POST /api/captions, polled, then installed with the store's installCaptions
// exactly as CaptionLibrary does), the set listing with its stale check, set/line styling (CaptionInspector's
// apply-to-set) and the SRT/VTT sidecar written with the app's own serializers. Line edits are act; see help captions.
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { call, edit, handle, need, project, timeline, clip, store, done, ApiFailure, type JobDef, type Poller, type Step } from './kit.ts';
import { flush } from '../session.ts';
import { secs } from '../views.ts';
import { captionPresets, captionSignature, isCaption, restyleCaption, subtitleCues, subtitleFile, type CaptionJob, type CaptionSet } from '../../src/services/captions.ts';
import { getText, type TextDocument } from '../../src/services/text.ts';

const PRESETS: string[] = captionPresets.map(p => p.id);
const PRESET_FONTS = [...new Set<string>(captionPresets.map(p => p.font))];
// Caption job ids are not store ids, so they print bare (an @handle would not resolve): the first 8 hex of the uuid.
const short = (id: string) => id.replace(/^caption-/, '').slice(0, 8);
const span = (a: number, b: number) => `${secs(a)}–${secs(b)}s`;
const opt = <T>(params: Record<string, any>, key: string, type: 'string' | 'number' | 'boolean') => params[key] === undefined ? undefined : need<T>(params, key, type);
const color = (params: Record<string, any>, key: string) => {
  const value = opt<string>(params, key, 'string');
  if (value !== undefined && !/^#[\da-f]{6}$/i.test(value)) throw new Error(`params.${key} must be a #rrggbb color.`);
  return value;
};
function preset(params: Record<string, any>) {
  const id = opt<string>(params, 'preset', 'string');
  if (id !== undefined && !PRESETS.includes(id)) throw new Error(`Unknown caption preset "${id}". Presets: ${PRESETS.join(', ')}.`);
  return id;
}
function wordsPerLine(params: Record<string, any>) {
  const n = opt<number>(params, 'wordsPerLine', 'number');
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 15)) throw new Error('params.wordsPerLine is a whole number 1–15.');
  return n;
}

/** Sets that still hold lines, as the Captions library lists them. */
function setsOn(timelineId: string) {
  const s = store.getState();
  return s.tracks.filter(t => t.timelineId === timelineId).flatMap(t => t.captionSets ?? []).filter(meta => s.clips.some(c => c.properties.captionSet === meta.id));
}
const linesOf = (setId: string) => store.getState().clips.filter(c => c.properties.captionSet === setId).sort((a, b) => a.start - b.start);
const linesJson = (setIds: string[]) => JSON.stringify(store.getState().clips.filter(c => setIds.includes(String(c.properties.captionSet))));
const installed = (jobId: string) => store.getState().tracks.flatMap(t => t.captionSets ?? []).find(meta => meta.jobId === jobId);

/** CaptionLibrary.apply: install a complete job's words on its own timeline. `before` arms the replace guard. */
async function install(job: CaptionJob, before?: string, words?: number, style?: string): Promise<Step> {
  const tag = `captions job ${short(job.id)}`;
  if (job.status !== 'complete') throw new Error(`${tag} ${job.status}${job.error ? `: ${job.error.slice(-200)}` : ` (${job.stage})`}. Run job captions again with the same params to retry.`);
  if (!job.words?.length) return done(`${tag}: no speech detected in ${span(job.start, job.end)}.`);
  const existing = installed(job.id);
  if (existing) return done(`${tag} is already on the timeline as set ${handle(existing.id)}.`);
  const removing = [...job.removeSets ?? [], ...job.replaceSet ? [job.replaceSet] : []];
  if (before !== undefined && removing.length && before !== linesJson(removing))
    return done(`${tag} is ready, but the caption lines it replaces were edited while it ran, so nothing was replaced. Replace them anyway: job captions{job:"${short(job.id)}"}.`);
  const locked = store.getState().tracks.find(x => x.timelineId === job.timelineId && x.captionSets && x.locked);
  if (locked) throw new Error(`${tag} is ready, but the Captions track ${handle(locked.id)} is locked. act updateTrack("${handle(locked.id)}",{locked:false}), then job captions{job:"${short(job.id)}"}.`);
  const n = words ?? job.wordsPerLine ?? 5, look = style ?? job.preset ?? 'highlight';
  let set: CaptionSet | undefined;
  const was = store.getState().timelineId;
  await edit(async run => {
    // installCaptions only acts on the open project and timeline.
    if (store.getState().projectId !== job.projectId) store.getState().openProject(job.projectId);
    if (store.getState().timelineId !== job.timelineId) store.getState().setTimeline(job.timelineId);
    await run('installCaptions', job, n, look, job.replaceSet);
    set = installed(job.id);
    if (!set) throw new Error(`${tag} could not be installed: it needs an editor role, its timeline, and an unlocked Captions track.`);
  });
  const track = store.getState().tracks.find(t => t.captionSets?.some(meta => meta.id === set!.id))!;
  const unsure = job.words.filter(w => w.uncertain).length;
  return done(`Captions set ${handle(set!.id)} on track ${handle(track.id)}: ${linesOf(set!.id).length} lines, ${job.words.length} words${unsure ? ` (${unsure} uncertain timings)` : ''}, ${span(job.start, job.end)}, ${n} words/line, ${look}${removing.length ? `, replaced ${removing.length} set${removing.length === 1 ? '' : 's'}` : ''}.${was !== job.timelineId ? ` Opened its timeline ${handle(job.timelineId)}.` : ''}`);
}

function follow(id: string, before?: string, words?: number, style?: string): Poller {
  let status = 'waiting';
  return {
    label: `captions job ${short(id)}`,
    async poll() {
      let job: CaptionJob;
      // A tunnel blip or a restarting server is not the transcription failing: look again next round.
      try { ({ job } = await call<{ job: CaptionJob }>(`/captions/${id}`)); }
      catch (error) { if (error instanceof TypeError || error instanceof ApiFailure && (error.status >= 500 || error.status === 429)) return { done: false, text: `captions job ${short(id)}: server unreachable, retrying` }; throw error; }
      status = job.status;
      if (job.status === 'waiting' || job.status === 'running') return { done: false, text: `captions job ${short(id)}: ${job.stage} ${Math.floor(job.progress)}% · ${span(job.start, job.end)}` };
      return install(job, before, words, style);
    },
    // Cancelling a complete job would flip it to cancelled and make it uninstallable (the server does not check).
    async cancel() {
      if (status === 'waiting' || status === 'running') status = (await call<{ job: CaptionJob }>(`/captions/${id}`)).job.status;
      if (status === 'waiting' || status === 'running') await call(`/captions/${id}`, { method: 'DELETE' });
    },
  };
}

export const jobs: Record<string, JobDef> = {
  captions: {
    doc: '{start?,end?,source?:track,wordsPerLine?=5,preset?=highlight,replace?:set,overlap?:keep|replace} | {job} transcribes speech (English) → caption set. help captions',
    async start(params) {
      const p = project(), t = timeline(), s = store.getState();
      if (params.job !== undefined) {
        const want = String(params.job).replace(/^@/, '').replace(/^caption-/, '');
        const { jobs: list } = await call<{ jobs: CaptionJob[] }>(`/captions?projectId=${encodeURIComponent(p.id)}`);
        const job = want.length >= 4 ? list.find(j => j.id.slice(8).startsWith(want)) : undefined;
        if (!job) throw new Error(`No caption job "${want}" in this project. job caption-sets lists them.`);
        return follow(job.id, undefined, wordsPerLine(params), preset(params));
      }
      const sets = setsOn(t.id);
      const replace = params.replace === undefined ? undefined : sets.find(meta => meta.id === params.replace);
      if (params.replace !== undefined && !replace) throw new Error(`No caption set ${handle(String(params.replace))} on this timeline. job caption-sets lists them.`);
      let trackIds = replace?.trackIds ?? [];
      if (params.source !== undefined) {
        const source = s.tracks.find(x => x.id === params.source && x.timelineId === t.id && !x.captionSets);
        if (!source) throw new Error(`params.source must be a track on this timeline other than the Captions track (or leave it out for the audible mix).`);
        trackIds = [source.id];
      }
      const limit = Math.min(21600, t.duration);
      const start = opt<number>(params, 'start', 'number') ?? replace?.start ?? 0;
      const end = Math.min(limit, opt<number>(params, 'end', 'number') ?? replace?.end ?? Math.max(1, ...s.clips.filter(c => c.timelineId === t.id && !isCaption(c)).map(c => c.start + c.duration)));
      if (!(start >= 0 && end - start >= 1 / p.fps)) throw new Error(`Range ${span(start, end)} is empty or outside the timeline (0–${secs(limit)}s).`);
      const overlaps = sets.filter(meta => meta.id !== replace?.id && s.clips.some(c => c.properties.captionSet === meta.id && c.start < end && c.start + c.duration > start));
      if (overlaps.length && params.overlap !== 'keep' && params.overlap !== 'replace')
        throw new Error(`Caption set ${overlaps.map(meta => `${handle(meta.id)} (${span(meta.start, meta.end)})`).join(', ')} overlaps ${span(start, end)}. Pass overlap:"keep" (both stay) or "replace" (all its lines go, also outside this range).`);
      const removeSets = params.overlap === 'replace' ? overlaps.map(meta => meta.id) : [];
      const n = wordsPerLine(params) ?? replace?.wordsPerLine ?? 5, look = preset(params) ?? replace?.preset ?? 'highlight';
      // The server transcribes its own saved copy: save first, as the Captions library does.
      await flush();
      const now = store.getState();
      const { job } = await call<{ job: CaptionJob }>('/captions', { method: 'POST', json: { projectId: p.id, timelineId: t.id, start, end, trackIds, wordsPerLine: n, preset: look, replaceSet: replace?.id, removeSets, signature: captionSignature(now.clips, now.tracks, t.id, start, end, trackIds) } });
      return follow(job.id, linesJson([...removeSets, ...replace ? [replace.id] : []]));
    },
  },
  'caption-sets': {
    doc: '{} caption sets on this timeline (stale = audio changed since) + recent transcription jobs',
    async start() {
      const p = project(), t = timeline(), s = store.getState();
      const { available, jobs: list } = await call<{ available: boolean; jobs: CaptionJob[] }>(`/captions?projectId=${encodeURIComponent(p.id)}`);
      const sets = setsOn(t.id), track = s.tracks.find(x => x.timelineId === t.id && x.captionSets);
      const out = [`captions ${available ? 'available' : 'NOT installed on this server (npm run setup:captions there)'} · timeline ${handle(t.id)}`];
      if (track) out.push(`track ${handle(track.id)} V${track.number} "${track.name}"${track.hidden ? ' · hidden (not burned in)' : ''}${track.locked ? ' · locked' : ''}`);
      for (const meta of sets) {
        const stale = meta.signature !== captionSignature(s.clips, s.tracks, t.id, meta.start, meta.end, meta.trackIds);
        out.push(`set ${handle(meta.id)} ${span(meta.start, meta.end)} · ${linesOf(meta.id).length} lines · ${meta.wordsPerLine} words/line · ${meta.preset}${meta.trackIds.length ? ` · source ${meta.trackIds.map(handle).join(',')}` : ''}${stale ? ' · STALE (audio changed): captions{replace}' : ''}`);
      }
      if (!sets.length) out.push('no caption sets on this timeline');
      const mine = list.filter(j => j.timelineId === t.id);
      for (const j of mine.filter((j, i) => (i === 0 || j.status === 'waiting' || j.status === 'running') && !sets.some(meta => meta.jobId === j.id)).slice(0, 5)) {
        const state = j.status === 'waiting' || j.status === 'running' ? `${j.stage} ${Math.floor(j.progress)}%`
          : j.status === 'complete' ? (j.stage === 'No speech detected' ? 'no speech detected' : `ready, not installed: captions{job:"${short(j.id)}"}`)
          : `${j.status}${j.error ? `: ${j.error.slice(-120)}` : ''}`;
        out.push(`job ${short(j.id)} ${span(j.start, j.end)} ${state}`);
      }
      return done(out.join('\n'));
    },
  },
  'caption-style': {
    doc: '{set|lines, preset?,color?,size?,y?,font?,weight?,outline?,outlineColor?,shadow?,accent?,wordPop?,entrance?,exit?} restyles caption lines',
    async start(params) {
      const t = timeline(), look = preset(params);
      const setId = params.set === undefined ? undefined : String(params.set);
      if (setId !== undefined && !setsOn(t.id).some(meta => meta.id === setId)) throw new Error(`No caption set ${handle(setId)} on this timeline. job caption-sets lists them.`);
      const ids: string[] = setId || params.lines === undefined ? [] : [params.lines].flat().map(String);
      if (!setId && !ids.length) throw new Error('params.set (a caption set) or params.lines (caption line ids) is required.');
      for (const id of ids) if (!isCaption(clip(id))) throw new Error(`${handle(id)} is not a caption line.`);
      const fill = color(params, 'color'), outlineColor = color(params, 'outlineColor'), accent = color(params, 'accent');
      const size = opt<number>(params, 'size', 'number'), y = opt<number>(params, 'y', 'number'), weight = opt<number>(params, 'weight', 'number');
      const outline = opt<number>(params, 'outline', 'number'), shadow = opt<number>(params, 'shadow', 'number');
      const entrance = opt<number>(params, 'entrance', 'number'), exit = opt<number>(params, 'exit', 'number'), wordPop = opt<boolean>(params, 'wordPop', 'boolean');
      const font = params.font === undefined ? undefined : await fontFamily(need(params, 'font'));
      const changed = ['preset', 'color', 'size', 'y', 'font', 'weight', 'outline', 'outlineColor', 'shadow', 'accent', 'wordPop', 'entrance', 'exit'].filter(key => params[key] !== undefined);
      if (!changed.length) throw new Error('Nothing to change: give preset or a style property.');
      const style = { ...fill && { color: fill }, ...size !== undefined && { fontSize: size }, ...font && { fontFamily: font }, ...weight !== undefined && { fontWeight: Math.round(weight / 100) * 100 } };
      // CaptionInspector's per-line edits, applied to each line's own document so text and timing stay.
      const restyle = (doc: TextDocument): TextDocument => ({
        ...doc, ...y !== undefined && { y }, ...shadow !== undefined && { shadowOpacity: shadow }, ...outline !== undefined && { outlineWidth: outline }, ...outlineColor && { outlineColor },
        runs: doc.runs.map(r => ({ ...r, style: { ...r.style, ...style } })),
        caption: { ...doc.caption!, ...entrance !== undefined && { entranceDuration: entrance }, ...exit !== undefined && { exitDuration: exit }, ...accent && { accent }, ...wordPop !== undefined && { wordPop } },
      });
      let count = 0;
      await edit(async run => {
        // A set's preset goes through styleCaptions, which also records it on the set (regroup keeps it).
        if (look && setId) await run('styleCaptions', setId, look);
        const lines = setId ? linesOf(setId) : ids.map(clip);
        count = lines.length;
        if (changed.some(key => key !== 'preset') || (look && !setId))
          await run('updateText', lines.map(c => ({ id: c.id, doc: restyle(look && !setId ? restyleCaption(getText(c), look) : getText(c)) })));
      });
      return done(`${setId ? `Set ${handle(setId)}` : 'Lines'}: ${count} caption lines restyled (${changed.join(', ')}).`);
    },
  },
  subtitles: {
    doc: '{path, format?:srt|vtt, start?, end?} writes the caption lines to a local subtitle file, timed from start',
    async start(params) {
      const raw = need(params, 'path'), ext = extname(raw).slice(1).toLowerCase();
      const format = opt<string>(params, 'format', 'string') ?? (ext === 'vtt' ? 'vtt' : 'srt');
      if (format !== 'srt' && format !== 'vtt') throw new Error('params.format is srt or vtt.');
      const s = store.getState(), t = timeline();
      // DeliverWorkspace's whole-timeline range.
      const start = opt<number>(params, 'start', 'number') ?? 0, end = opt<number>(params, 'end', 'number') ?? Math.max(0, ...s.clips.filter(c => c.timelineId === t.id).map(c => c.start + c.duration));
      const cues = subtitleCues(s.clips, t.id, start, end);
      if (!cues.length) throw new Error(`No caption lines in ${span(start, end)} on this timeline.`);
      let path = resolve(raw.replace(/^~(?=$|[\\/])/, homedir()));
      if (/[\\/]$/.test(raw) || existsSync(path) && statSync(path).isDirectory()) path = join(path, `${t.name.replace(/[\\/:*?"<>|]/g, '_') || 'Subtitles'}.${format}`);
      else if (ext !== format) path += `.${format}`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, subtitleFile(cues, format));
      return done(`Wrote ${cues.length} cues (${span(start, end)}) to ${path}`);
    },
  },
};

/** A font that burn-in can render: a preset font, or a shared font uploaded to the server (family FL-…). */
async function fontFamily(name: string) {
  if (PRESET_FONTS.includes(name)) return name;
  const { fonts } = await call<{ fonts: { name: string; family: string }[] }>('/fonts');
  const hit = fonts.find(f => f.family === name || f.name.toLowerCase() === name.toLowerCase());
  if (!hit) throw new Error(`Font "${name}" would not export. Use one of: ${[...PRESET_FONTS, ...fonts.map(f => f.name)].join(', ')}, or upload it as a shared font first.`);
  return hit.family;
}

export const topics: Record<string, string> = {
  captions: [
    'captions: speech-to-text caption sets (English) on the timeline\'s one Captions track. Jobs: captions, caption-sets, caption-style, subtitles. Line edits are act.',
    'generate: job captions{} transcribes the whole edit from the audible mix; start/end (s) narrow it, source:<track> uses one track. Runs on the server behind exports and other GPU work (often minutes); progress sitting near 10% is normal. Installs as one undoable edit.',
    'regenerate a set (audio changed = STALE in caption-sets): job captions{replace:set} reuses its range, source, words/line and preset. A set overlapping the range needs overlap:"keep"|"replace". A finished job not yet installed: job captions{job:"<8 hex>"}.',
    'presets (id · name · group · font weight · motion · highlight color); Cinema = 52 px, Social = 76 px:',
    ...captionPresets.map(p => `  ${p.id} · ${p.name} · ${p.group} · ${p.font} ${p.weight} · ${p.motion}${p.highlight ? ` · ${p.accent}` : ''}${p.backing ? ' · backing' : ''}`),
    'lines: each line is a CAPTION clip on the Captions track; timeline{track:"<that track>"} lists them. Words: get{id:line, path:"properties.textDocument.caption.words"}: [{text,start,end,uncertain?}], seconds from the line\'s original start.',
    'fix text: act updateCaption(line, words) with the whole word list. Same word count: keep each start/end, change text. Different count: spread times across the old first start–last end, uncertain:true (what the editor does).',
    'word timing: updateCaption with corrected start/end and uncertain:false. Line timing: moveClip(line, start), trimClip(line, line start, duration).',
    'regroup: regroupCaptions(set, wordsPerLine 1–15) keeps edited words and times; every line gets a new id and per-line styling resets to the set preset.',
    'whole-set preset: styleCaptions(set, presetId) keeps per-line tweaks. Color, size, position, font, outline, shadow, highlight, word pop, entrance/exit: job caption-style{set|lines, …}.',
    `caption-style values: size px (editor 20–300), y 0.05–0.9 of frame height (0.78 default), shadow 0–100, outline 0–60, weight 100–900, entrance/exit 0–5 s, color/outlineColor/accent #rrggbb, wordPop true pops each word. Fonts that export: ${PRESET_FONTS.join(', ')}, or a shared font uploaded to the server.`,
    'delete one set: act{select:[every line of the set], do:[["deleteClip","<one of them>"]]}; the set goes with its last line. All captions: act deleteTrack(captions track). Undo: act undo.',
    'export: a visible Captions track is burned into the video; act updateTrack(track,{hidden:true}) leaves it out. Burn-in fails on a caption line with an effect or crop, or a font the server lacks. Sidecar file: job subtitles{path}.',
  ].join('\n'),
};
