// Build a SharedCut timeline from an edit JSON in one state delta, so an agent can cut a reel.
//
//   FRAME_LINE_COOKIE='frameline_session=…' node --experimental-strip-types scripts/build-timeline.mjs reel1.json [--render] [--dry-run]
//
// FRAME_LINE_URL (default http://127.0.0.1:4310) picks the server. Rerunning replaces what the last run
// wrote (clip ids are derived from the edit's ids) and leaves clips made by hand alone.
// The edit format is documented in docs/reels-workflow.md.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { captionDocument, captionPreset, captionSignature, groupCaptionWords } from '../src/services/captions.ts';
import { validateText } from '../src/services/text.ts';
import { defaultShape, validateShape } from '../src/services/shapes.ts';
import { validateKeyframes } from '../src/services/animation.ts';
import { defaultProperties } from '../src/state/demo.ts';
import { agentCookie, patchState } from './state-patch.mjs';

export const eases = { linear: null, hold: null, inOutCubic: [.65, 0, .35, 1], outCubic: [.33, 1, .68, 1], inCubic: [.32, 0, .67, 0], outBack: [.34, 1.56, .64, 1], inOutBack: [.68, -.6, .32, 1.6], outExpo: [.16, 1, .3, 1], inOutExpo: [.87, 0, .13, 1] };
const hash = value => createHash('sha1').update(value).digest('hex').slice(0, 10);
const slug = value => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(String(value))) throw new Error(`Use letters, digits, - and _ for ids: ${value}`); return value; };

/** `{"properties.zoom": [[0, 100, "outBack"], [0.3, 108]]}` or full keyframe objects. */
function keyframes(channels = {}, gain) {
  const out = {};
  for (const [path, keys] of Object.entries(gain ? { ...channels, 'properties.gain': gain } : channels)) {
    out[path] = keys.map((key, i) => {
      if (!Array.isArray(key)) return { id: `k${i}`, interpolation: 'linear', ...key };
      const [time, value, ease = 'linear'] = key;
      if (!(ease in eases)) throw new Error(`Unknown ease "${ease}". Use ${Object.keys(eases).join(', ')}.`);
      return { id: `k${i}`, time, value, interpolation: ease === 'hold' ? 'hold' : eases[ease] ? 'bezier' : 'linear', ...(eases[ease] ? { curve: eases[ease] } : {}) };
    });
  }
  if (Object.keys(out).length) validateKeyframes(out);
  return Object.keys(out).length ? out : undefined;
}

/** Pure: the delta that makes `state` hold `edit`. `words` are the caption job's timeline-time words. */
export function buildDelta(state, edit, words) {
  const project = state.projects.find(p => p.id === edit.project || p.name === edit.project) ?? (() => { throw new Error(`No project "${edit.project}".`); })();
  const timeline = state.timelines.find(t => t.projectId === project.id && (!edit.timeline || t.id === edit.timeline || t.name === edit.timeline)) ?? (() => { throw new Error('That project has no such timeline.'); })();
  const prefix = `bt-${hash(timeline.id)}-`, own = id => prefix + slug(id);
  const tracks = state.tracks.filter(t => t.timelineId === timeline.id), trackUpserts = [], trackIds = new Map();
  for (const spec of edit.tracks ?? []) {
    const existing = tracks.find(t => t.id === own(spec.id)) ?? tracks.find(t => !t.captionSets && t.kind === spec.kind && t.number === spec.number);
    const track = { hidden: false, muted: false, solo: false, locked: false, gain: 0, pan: 0, ...existing, id: existing?.id ?? own(spec.id), timelineId: timeline.id, name: spec.name ?? existing?.name ?? spec.id, kind: spec.kind, number: spec.number,
      ...Object.fromEntries(['gain', 'pan', 'muted', 'hidden'].filter(k => spec[k] !== undefined).map(k => [k, spec[k]])) };
    trackUpserts.push(track); trackIds.set(spec.id, track.id);
  }
  const trackOf = name => trackIds.get(name) ?? tracks.find(t => t.id === name || t.name === name)?.id ?? (() => { throw new Error(`No track "${name}". Declare it under "tracks".`); })();
  const media = state.media.filter(m => m.projectId === project.id);
  const base = (spec, mediaId, extra) => ({ id: own(spec.id), projectId: project.id, timelineId: timeline.id, trackId: trackOf(spec.track), mediaId, name: spec.name ?? spec.id, start: spec.start, sourceIn: 0, color: '#6f8fb3', disabled: false, effects: spec.effects ?? [], ...extra });

  const clips = [];
  for (const spec of edit.clips ?? []) {
    const asset = media.find(m => m.id === spec.media || m.name === spec.media) ?? (() => { throw new Error(`${spec.id}: no media "${spec.media}" in this project.`); })();
    const speed = spec.properties?.speed ?? 100, sourceIn = spec.in ?? 0;
    const duration = spec.duration ?? (spec.out - sourceIn) / (speed / 100);
    if (!(duration > 0)) throw new Error(`${spec.id}: give "out" after "in", or a positive "duration".`);
    const clip = base(spec, asset.id, { sourceIn, duration, properties: { ...defaultProperties, ...spec.properties }, keyframes: keyframes(spec.keyframes, spec.gain) });
    clip.color = asset.kind === 'audio' ? '#5f9c7d' : '#6f8fb3';
    clips.push(clip);
  }
  for (const spec of edit.text ?? []) {
    validateText(spec.doc);
    clips.push(base(spec, 'frameline-title', { duration: spec.duration, color: '#b58ad6', properties: { ...defaultProperties, ...spec.properties, textDocument: JSON.stringify(spec.doc) }, keyframes: keyframes(spec.keyframes) }));
  }
  for (const spec of edit.graphics ?? []) {
    const shape = { ...defaultShape(spec.shape?.kind), ...spec.shape }; validateShape(shape);
    clips.push(base(spec, 'frameline-shape', { duration: spec.duration, color: '#d6a35f', properties: { ...defaultProperties, ...spec.properties, shapeDocument: JSON.stringify(shape) }, keyframes: keyframes(spec.keyframes) }));
  }

  if (edit.captions) {
    const c = edit.captions, preset = captionPreset(c.preset ?? 'reel').id, wordsPerLine = c.wordsPerLine ?? 3;
    const spoken = (words ?? c.words ?? []).filter(w => w.end > (c.start ?? 0) && w.start < (c.end ?? Infinity));
    if (!spoken.length) throw new Error('Captions need words: a finished caption job id, or "words".');
    const end = c.end ?? spoken.at(-1).end + .12, start = c.start ?? spoken[0].start;
    const existing = tracks.find(t => t.captionSets);
    const track = existing ?? { id: own('captions'), timelineId: timeline.id, name: 'Captions', kind: 'video', number: Math.max(0, ...[...tracks, ...trackUpserts].filter(t => t.kind === 'video').map(t => t.number)) + 1, hidden: false, muted: true, solo: false, locked: false, gain: 0, pan: 0, captionSets: [] };
    const setId = own('caption-set'), style = c.style ?? {};
    // Preset first, custom styling last, as the inspector does.
    groupCaptionWords(spoken, wordsPerLine).forEach((line, index, groups) => {
      const from = line[0].start, to = Math.min(end, groups[index + 1]?.[0].start ?? end, line.at(-1).end + .12), duration = Math.max(.01, to - from);
      const doc = captionDocument(line.map(w => ({ ...w, start: w.start - from, end: w.end - from })), preset, duration);
      doc.runs = doc.runs.map(run => ({ ...run, style: { ...run.style, ...Object.fromEntries(['fontFamily', 'fontSize', 'fontWeight', 'color', 'letterSpacing'].filter(k => style[k] !== undefined).map(k => [k, style[k]])) } }));
      for (const k of ['outlineWidth', 'outlineColor', 'shadowOpacity', 'shadowBlur', 'shadowY', 'y', 'x', 'width', 'height']) if (style[k] !== undefined) doc[k] = style[k];
      for (const k of ['accent', 'wordPop', 'entranceDuration', 'exitDuration']) if (style[k] !== undefined) doc.caption[k] = style[k];
      validateText(doc);
      clips.push({ id: `${setId}-${index}`, projectId: project.id, timelineId: timeline.id, trackId: track.id, mediaId: 'frameline-title', name: line.map(w => w.text).join(' ').slice(0, 255), start: from, duration, sourceIn: 0, color: '#8970b6', disabled: false, properties: { captionSet: setId, textDocument: JSON.stringify(doc) }, effects: [] });
    });
    const sourceTracks = (c.tracks ?? []).map(trackOf);
    const others = state.clips.filter(clip => clip.timelineId === timeline.id && !clip.id.startsWith(prefix));
    const meta = { id: setId, jobId: c.job ?? 'inline', start, end, trackIds: sourceTracks, signature: captionSignature([...others, ...clips], [...tracks.filter(t => !trackUpserts.some(u => u.id === t.id)), ...trackUpserts], timeline.id, start, end, sourceTracks), wordsPerLine, preset };
    trackUpserts.push({ ...track, captionSets: [...(track.captionSets ?? []).filter(s => s.id !== setId), meta] });
  }

  const ids = new Set(clips.map(c => c.id));
  const stale = state.clips.filter(c => c.timelineId === timeline.id && c.id.startsWith(prefix) && !ids.has(c.id)).map(c => c.id);
  const length = Math.max(timeline.duration, ...clips.map(c => c.start + c.duration));
  return {
    clips: { upsert: clips.map(c => c.keyframes ? c : (({ keyframes, ...rest }) => rest)(c)), remove: stale },
    tracks: { upsert: trackUpserts, remove: [] },
    ...(length !== timeline.duration ? { timelines: { upsert: [{ ...timeline, duration: length }], remove: [] } } : {}),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), file = args.find(a => !a.startsWith('--'));
  if (!file) throw new Error('Pass the edit JSON.');
  const edit = JSON.parse(await readFile(file, 'utf8'));
  const server = (process.env.FRAME_LINE_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, ''), cookie = agentCookie();
  if (!cookie) throw new Error('Set FRAME_LINE_COOKIE, or run scripts/agent/agent-session.mjs on the server.');
  const call = async (path, init = {}) => {
    const response = await fetch(server + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), cookie } });
    const text = await response.text();
    if (!response.ok) { const error = new Error(`${path} -> ${response.status} ${text.slice(0, 500)}`); error.status = response.status; throw error; }
    return text ? JSON.parse(text) : null;
  };
  const words = edit.captions?.job ? (await call(`/api/captions/${edit.captions.job}`)).job.words : undefined;
  if (args.includes('--dry-run')) { const delta = buildDelta((await call('/api/state')).state, edit, words); console.log(JSON.stringify({ clips: delta.clips.upsert.length, removed: delta.clips.remove.length, tracks: delta.tracks.upsert.length }, null, 1)); process.exit(0); }
  let summary;
  await patchState(call, state => { const delta = buildDelta(state, edit, words); summary = `${delta.clips.upsert.length} clips, ${delta.clips.remove.length} removed`; return delta; });
  console.log(`Timeline updated: ${summary}.`);
  if (args.includes('--render')) {
    const { state } = await call('/api/state');
    const project = state.projects.find(p => p.id === edit.project || p.name === edit.project), timeline = state.timelines.find(t => t.projectId === project.id && (!edit.timeline || t.id === edit.timeline || t.name === edit.timeline));
    const { job } = await call('/api/renders', { method: 'POST', body: JSON.stringify({ projectId: project.id, name: edit.render?.name ?? `${project.name}.mp4`, preset: 'Custom', settings: {
      timelineId: timeline.id, resolution: project.resolution, fps: String(project.fps), codec: 'H.264', quality: 'High · 20 Mb/s', audio: 'AAC · 320 kb/s · 48 kHz', subtitles: 'None',
      rangeIn: '0', rangeOut: String(edit.render?.duration ?? timeline.duration), masterGain: '0', masterMuted: 'false', ...edit.render?.settings } }) });
    console.log(`Render queued: ${job.id}. Download from ${server}/api/renders/${job.id}/download when it completes.`);
  }
}
