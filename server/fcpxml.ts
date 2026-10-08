import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Clip, Effect, GradeNode, Keyframe, Marker, MediaAsset, Project, Timeline, Track } from '../src/state/models.ts';
import { boundedAnimationValue } from '../src/services/animation.ts';
import { blendModeNames } from '../src/services/blendModes.ts';
import { defaultTextEffects, defaultTextStyle, type TextDocument, type TextRun, type TextStyle } from '../src/services/text.ts';
import { transitionDefinitions } from '../src/services/transitions.ts';

/**
 * Final Cut Pro XML (FCPXML 1.x) → a SharedCut project. public/fcp.sh bundles the XML with its footage; this rebuilds
 * the edit. Storylines and connected lanes become tracks, compound and multicam clips become compositions, and
 * transforms, crops, opacity, volume, pan, audio fades, retimes, transitions and markers carry their keyframes over.
 * Whatever it cannot reproduce is named in `warnings`, never dropped silently.
 *
 * FCPXML time: rational seconds ("1001/30000s"). An element's `offset` is in its parent's local time and its own
 * local time begins at `start`, so its child at local t lands at parent(offset) + (t - start). A `timeMap` maps an
 * element's local time to its media's time. Spatial values are percent of the frame height from the centre, y up;
 * rotation is counterclockwise. SharedCut uses project pixels, y down, clockwise.
 */

export interface XmlNode { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (value: string) => value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name: string) =>
  name[0] !== '#' ? ENTITIES[name] ?? whole : String.fromCodePoint(/^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1))));

/** A strict reader for FCPXML: no namespaces, no entities beyond the predefined five, no internal DTD. */
export function parseXml(xml: string): XmlNode {
  const root: XmlNode = { name: '', attrs: {}, children: [], text: '' }, stack = [root];
  const token = /<!--([\s\S]*?)-->|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^>[]|\[[\s\S]*?\])*>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/y;
  while (token.lastIndex < xml.length) {
    const at = token.lastIndex, m = token.exec(xml), top = stack[stack.length - 1];
    if (!m) throw new Error(`The XML is damaged near character ${at}. Export it again from Final Cut.`);
    // Comments are kept as #comment children: Final Cut writes each color correction's ASC CDL in one.
    if (m[1] !== undefined) top.children.push({ name: '#comment', attrs: {}, children: [], text: m[1] });
    else if (m[2] !== undefined) top.text += m[2];
    else if (m[3]) { if (stack.length === 1 || top.name !== m[3]) throw new Error(`The XML is damaged: unexpected </${m[3]}>.`); stack.pop(); }
    else if (m[4]) {
      const node: XmlNode = { name: m[4], attrs: {}, children: [], text: '' };
      for (const a of m[5].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1]] = unescape(a[2] ?? a[3]);
      top.children.push(node);
      if (!m[6]) { stack.push(node); if (stack.length > 256) throw new Error('The XML nests too deeply.'); }
    } else if (m[7] !== undefined) top.text += unescape(m[7]);
  }
  if (stack.length !== 1) throw new Error('The XML ends early. Export it again from Final Cut.');
  return root;
}

export function fcpTime(value: string | undefined, fallback = 0) {
  if (value === undefined || value === '') return fallback;
  const m = /^(-?\d+(?:\.\d+)?)(?:\/(\d+))?s$/.exec(value.trim()), seconds = m ? Number(m[1]) / Number(m[2] ?? 1) : NaN;
  if (!Number.isFinite(seconds) || Math.abs(seconds) > 1e7) throw new Error(`Unreadable Final Cut time "${value}".`);
  return seconds;
}

/** The path a file:// URL names, decoded exactly as public/fcp.sh decodes it, so bundle sources.tsv keys match. */
export function fileUrlPath(src: string) {
  if (!/^file:/i.test(src)) return undefined;
  const raw = src.replace(/^file:\/\/(localhost)?/i, '');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/**
 * One SharedCut project per Final Cut project and importer: Final Cut keeps a project's uid across exports, so running
 * the import again resumes it and a re-export can rebuild it. XML without uids falls back to its own text.
 */
export function fcpProjectId(xml: string, userId: string) {
  const uids = [...xml.matchAll(/<project\b[^>]*?\suid="([^"]+)"/g)].map(m => m[1]);
  return 'fcp-' + createHash('sha256').update(`${userId}\n${uids.length ? uids.join('\n') : xml}`).digest('hex').slice(0, 32);
}

/** A bundle folder from public/fcp.sh (or a bare .fcpxml / .fcpxmld): the XML and where each source file now lives. */
export function readFcpBundle(path: string) {
  let file = path;
  if (statSync(path).isDirectory()) {
    if (existsSync(join(path, 'Info.fcpxml'))) file = join(path, 'Info.fcpxml');
    else {
      const found = readdirSync(path).filter(name => /\.fcpxml$/i.test(name) && !name.startsWith('._'));
      if (found.length !== 1) throw new Error(found.length ? `${path} holds ${found.length} .fcpxml files; pass the one to import.` : `No .fcpxml in ${path}. Point this at the folder sharedcut.com/fcp.sh made.`);
      file = join(path, found[0]);
    }
  }
  const folder = dirname(file), sources = new Map<string, string>(), table = join(folder, 'sources.tsv');
  if (existsSync(table)) for (const line of readFileSync(table, 'utf8').split('\n')) {
    const [original, relative] = line.split('\t');
    if (original && relative) sources.set(original, join(folder, ...relative.trim().split('/')));
  }
  // Title fonts public/fcp.sh found on the editor's Mac; the import adds them to SharedCut's font library first.
  const fontDir = join(folder, 'fonts');
  const fonts = existsSync(fontDir) ? readdirSync(fontDir).filter(name => /\.(ttf|otf|ttc|woff2?)$/i.test(name) && !name.startsWith('._')).map(name => join(fontDir, name)) : [];
  return { xml: readFileSync(file, 'utf8'), sources, fonts };
}

/** Bundle sources.tsv first, then the original path, then the one same-named file found under the media folders. */
export function locateSource(asset: Pick<MediaAsset, 'name' | 'sourcePath'>, sources: Map<string, string>, found: string[] = []) {
  const listed = asset.sourcePath ? sources.get(asset.sourcePath) : undefined;
  if (listed && existsSync(listed)) return listed;
  if (asset.sourcePath && existsSync(asset.sourcePath)) return asset.sourcePath;
  const hits = found.filter(file => basename(file) === asset.name);
  return hits.length === 1 ? hits[0] : undefined;
}

type Kind = 'video' | 'audio';
type Curve = [number, number, number, number];
type Keys = NonNullable<Clip['keyframes']>;
interface Frame { origin: number; start: number; rate: number }      // timeline = origin + (local - start) * rate
interface Span { lo: number; hi: number }
// depth: connections down from its storyline (a sync clip's own sound 0, sound synced to it 1). split: a J or L cut's
// sound. channel: one <audio srcCh> component of a source.
interface Placed { clip: Clip; kind: Kind; lane: number; depth: number; split?: boolean; channel?: boolean }
type Grade = Pick<GradeNode, 'name' | 'kind' | 'enabled' | 'parameters'>;
interface Adjusted { properties: Clip['properties']; keyframes: Keys; effects: Omit<Effect, 'id'>[]; grades: Grade[] }
// width/height: project pixels, which every timeline is laid out in. scale: project pixels per pixel of the timeline's
// own format, which title positions and sizes are in. soundWin: a wrapper's split-edit sound range, for its parts.
interface Ctx { timeline: Timeline; fps: number; width: number; height: number; scale: number; placed: Placed[]; markers: Marker[]; count: number; links: number; depth: number; soundWin?: Span }

const ITEMS = new Set(['asset-clip', 'clip', 'sync-clip', 'ref-clip', 'mc-clip', 'video', 'audio', 'title', 'gap', 'spine', 'audition']);
// Metadata, and elements their owner reads: never worth a warning on their own.
const QUIET = new Set(['#comment', 'note', 'keyword', 'rating', 'analysis-marker', 'metadata', 'marker', 'chapter-marker', 'transition', 'timeMap', 'conform-rate', 'param', 'text', 'text-style-def', 'mc-source', 'sync-source', 'audio-channel-source', 'audio-role-source', 'adjust-transform', 'adjust-crop', 'adjust-blend', 'adjust-volume', 'adjust-panner', 'adjust-conform', 'filter-video', 'filter-video-mask', 'filter-audio']);
// Story elements SharedCut has no counterpart for: named in the report wherever they hang.
const UNREAD = new Set(['caption', 'live-drawing']);
const IMAGE = /\.(png|jpe?g|tiff?|heic|psd|gif|bmp|webp)$/i;
const EASE: Record<string, Curve> = { ease: [.42, 0, .58, 1], easeIn: [.42, 0, 1, 1], easeOut: [0, 0, .58, 1] };
// Final Cut transition → the nearest SharedCut one. Only the first two are the same effect; the rest are named in the report.
const TRANSITIONS: Record<string, string> = { 'Cross Dissolve': 'Cross dissolve', 'Fade To Color': 'Dip to black', Flash: 'Camera flash', 'Zoom & Pan': 'Zoom in', Simple: 'Blur dissolve',
  'Cross Blur': 'Blur dissolve', Gaussian: 'Blur dissolve', Zoom: 'Zoom in', Push: 'Push left', Slide: 'Slide over', Spin: 'Spin', Wipe: 'Linear wipe', Circle: 'Iris', Bloom: 'Glow bleed' };
const EXACT_TRANSITIONS = new Set(['Cross Dissolve', 'Fade To Color']);
// Final Cut writes a blend mode as "<number> (<name>)" and reads only the number.
const BLENDS: Record<string, string> = { 0: 'Normal', 3: 'Darken', 4: 'Multiply', 5: 'Color burn', 8: 'Add', 9: 'Lighten', 10: 'Screen', 11: 'Color dodge', 12: 'Add', 14: 'Overlay', 15: 'Soft light', 16: 'Hard light', 22: 'Difference', 23: 'Exclusion' };
const NTSC: Record<string, number> = { '23.98': 24000 / 1001, '29.97': 30000 / 1001, '47.95': 48000 / 1001, '59.94': 60000 / 1001, '119.88': 120000 / 1001 };
const TEXT_LIMIT = 10_000;      // characters in one SharedCut text box
// Final Cut video effect → SharedCut effect, with Final Cut's Amount steps (Low, Moderate, High, Max) as percent.
const EFFECTS: Record<string, { name: string; amount: (value: number) => number }> = { 'Noise Reduction': { name: 'Noise Reduction', amount: v => [25, 50, 75, 100][Math.round(v)] ?? 50 } };
const fontKey = (family: string) => family.toLowerCase().replace(/[^a-z0-9]/g, '');
const at = (f: Frame, local: number) => f.origin + (local - f.start) * f.rate;
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const child = (node: XmlNode | undefined, name: string) => node?.children.find(c => c.name === name);
const param = (node: XmlNode | undefined, name: string) => node?.children.find(c => c.name === 'param' && c.attrs.name === name);
const keyNodes = (p: XmlNode | undefined) => child(p, 'keyframeAnimation')?.children.filter(k => k.name === 'keyframe') ?? [];
const pair = (value: string | undefined): [number, number] => { const [a = 0, b = a] = (value ?? '').trim().split(/\s+/).filter(Boolean).map(Number); return [Number.isFinite(a) ? a : 0, Number.isFinite(b) ? b : 0]; };
const decibels = (value: string) => /-?inf/i.test(value) ? -60 : Number.parseFloat(value) || 0;
const laneOf = (node: XmlNode) => Number(node.attrs.lane) || 0;
/** The first name that is not blank: Final Cut may write name="". */
const nameOf = (...names: (string | undefined)[]) => names.map(n => n?.trim()).find(Boolean) ?? 'Clip';
const splitEdit = (node: XmlNode) => node.attrs.audioStart !== undefined || node.attrs.audioDuration !== undefined;
const findAll = (node: XmlNode, name: string): XmlNode[] => node.children.flatMap(c => c.name === name ? [c] : c.name === 'resources' ? [] : findAll(c, name));
const hex = (rgba: string | undefined, fallback: string) => {
  const parts = (rgba ?? '').trim().split(/\s+/).map(Number);
  return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? '#' + parts.slice(0, 3).map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('') : fallback;
};

/**
 * `fonts` is SharedCut's font library: title fonts resolve to its entries by name. `measure` gives a text's width in
 * project pixels as the renderer sets it, so titles can be shrunk to fit as Final Cut's Auto-Shrink does.
 */
export function importFcpxml(xml: string, projectId: string, userId: string, fonts: { id: string; name: string }[] = [], measure?: (text: string, style: TextStyle) => number) {
  const document = parseXml(xml.replace(/^\uFEFF/, '')).children.find(n => n.name === 'fcpxml');
  if (!document) throw new Error('That file is not Final Cut XML. In Final Cut choose File > Export XML….');
  const projects = findAll(document, 'project');
  if (!projects.length) throw new Error('No project in that XML. In Final Cut select a project (not clips or an event), then File > Export XML….');
  const id = (kind: string, value: string) => `${projectId}-${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
  const resources = new Map<string, XmlNode>();
  for (const r of child(document, 'resources')?.children ?? []) if (r.attrs.id) resources.set(r.attrs.id, r);
  // Repeated gaps are counted, so the report reads `Effect "Blur" is not imported yet (×12)`, not twelve lines.
  const gaps = new Map<string, number>(), gap = (what: string) => gaps.set(what, (gaps.get(what) ?? 0) + 1);
  const media = new Map<string, MediaAsset>(), mediaById = new Map<string, MediaAsset>();
  const timelines: Timeline[] = [], tracks: Track[] = [], clips: Clip[] = [], nodes: GradeNode[] = [], orders = new Map<string, number>();
  const compositions = new Map<string, Timeline>(), building = new Set<string>();
  const skip = (name: string) => gap(name === 'caption' ? 'Captions are not imported yet' : `<${name}> is not imported`);
  let placedCount = 0;

  const format = (ref: string | undefined) => {
    const f = ref ? resources.get(ref) : undefined, frame = fcpTime(f?.attrs.frameDuration, 0);
    return { fps: frame > 0 ? 1 / frame : 0, width: Number(f?.attrs.width) || 0, height: Number(f?.attrs.height) || 0 };
  };
  const firstFormat = format(child(projects[0], 'sequence')?.attrs.format);
  const projectFps = firstFormat.fps || 30, projectWidth = firstFormat.width || 1920, projectHeight = firstFormat.height || 1080;

  const library = fonts.map(f => ({ id: f.id, key: fontKey(f.name) }));
  const resolved = new Map<string, string>();
  const fontFor = (family: string) => {
    if (resolved.has(family)) return resolved.get(family)!;
    const key = fontKey(family), match = library.find(f => f.key === key) ?? library.find(f => key && f.key.startsWith(key));
    if (!match && !/^(helvetica|helvetica neue|arial)$/i.test(family)) gap(`Font "${family}" is not in SharedCut's font library; its titles use a stand-in until the font is added and the project is imported again with rebuild`);
    resolved.set(family, match?.id ?? family);
    return resolved.get(family)!;
  };

  const mediaFor = (asset: XmlNode) => {
    const src = asset.children.find(c => c.name === 'media-rep' && c.attrs.kind === 'original-media')?.attrs.src ?? asset.attrs.src;
    const path = src ? fileUrlPath(src) : undefined;
    if (!path) return undefined;
    let item = media.get(path);
    if (item) return item;
    // Limits are checked as the import grows, so an oversized XML stops early instead of converting in full first.
    if (media.size >= 5000) throw new Error('Import at most 5,000 source files per project.');
    const f = format(asset.attrs.format), kind = IMAGE.test(path) ? 'image' : asset.attrs.hasVideo === '1' ? 'video' : 'audio';
    item = { id: id('media', path), projectId, name: path.split(/[\\/]/).pop()!.slice(0, 255) || 'Source', kind, binId: kind === 'audio' ? 'audio' : kind === 'image' ? 'graphics' : 'broll', thumbnail: '',
      duration: Math.max(0, fcpTime(asset.attrs.duration)), resolution: f.width ? `${f.width} × ${f.height}` : '', fps: kind === 'video' ? f.fps : 0, size: '', status: 'failed', progress: 0,
      sourcePath: path, hasAudio: asset.attrs.hasAudio === '1', error: 'Source file not uploaded yet. Run the Final Cut import again with its media.' };
    media.set(path, item); mediaById.set(item.id, item);
    return item;
  };

  function buildTimeline(key: string, name: string, formatRef: string | undefined, duration: number, composition: boolean, fill: (ctx: Ctx) => void) {
    const f = format(formatRef);
    const timeline: Timeline = { id: id('timeline', key), projectId, name: nameOf(name, 'Timeline').slice(0, 255), duration: 0, ...(composition ? { composition: true } : {}) };
    // A SharedCut project has one size and every timeline is laid out in it; one of another shape is reported.
    if (!composition && f.width && f.height && Math.abs(f.width / f.height - projectWidth / projectHeight) > 1e-3) gap(`Timeline "${timeline.name}" is ${f.width} × ${f.height}; it is laid out in the project's ${projectWidth} × ${projectHeight}`);
    const ctx: Ctx = { timeline, fps: f.fps || projectFps, width: projectWidth, height: projectHeight, scale: f.height ? projectHeight / f.height : 1, placed: [], markers: [], count: 0, links: 0, depth: 0 };
    fill(ctx);
    assignTracks(ctx);
    timeline.duration = Math.max(duration, ...ctx.placed.map(p => p.clip.start + p.clip.duration), 1 / ctx.fps);
    if (ctx.markers.length) timeline.markers = ctx.markers.sort((a, b) => a.time - b.time).slice(0, 10_000);
    Object.assign(timeline, { frameRate: ctx.fps });
    timelines.push(timeline);
    clips.push(...ctx.placed.map(p => p.clip));
    return timeline;
  }

  const frame = (ctx: Ctx, t: number) => Math.round(t * ctx.fps) / ctx.fps;
  /** The part of [begin, begin + length) inside the window, on the frame grid; `exact` keeps sound edits sample-accurate. */
  const visible = (ctx: Ctx, begin: number, length: number, win: Span, exact = false): Span | undefined => {
    const snap = (t: number) => exact ? round(t) : frame(ctx, t), lo = snap(Math.max(begin, win.lo)), hi = snap(Math.min(begin + length, win.hi));
    return hi - lo > (exact ? 1e-4 : .5 / ctx.fps) ? { lo, hi } : undefined;
  };
  const link = (ctx: Ctx) => id('link', `${ctx.timeline.id}/link/${ctx.links++}`);
  const place = (ctx: Ctx, kind: Kind, lane: number, clip: Omit<Clip, 'id' | 'projectId' | 'timelineId' | 'trackId' | 'effects'>, look?: Pick<Adjusted, 'effects' | 'grades'>) => {
    if (++placedCount > 20_000) throw new Error('Import at most 20,000 timeline items.');
    const placed: Placed = { kind, lane, depth: ctx.depth, clip: { id: id('clip', `${ctx.timeline.id}/${ctx.count++}`), projectId, timelineId: ctx.timeline.id, trackId: '', effects: [], ...clip } };
    if (!Object.keys(placed.clip.keyframes ?? {}).length) delete placed.clip.keyframes;
    if (look) attach(placed.clip, look);
    ctx.placed.push(placed);
    return placed;
  };
  /** Effects and grade nodes onto a clip, after any it already has. */
  const attach = (clip: Clip, look: Pick<Adjusted, 'effects' | 'grades'>) => {
    const start = clip.effects.length, order = orders.get(clip.id) ?? 0;
    orders.set(clip.id, order + look.grades.length);
    clip.effects = [...clip.effects, ...look.effects.map((e, i) => ({ ...e, id: id('effect', `${clip.id}/${start + i}`) }))];
    for (const [i, g] of look.grades.entries()) nodes.push({ ...structuredClone(g), id: id('grade', `${clip.id}/${order + i}`), projectId, clipId: clip.id, order: order + i + 1 });
  };

  /** A storyline: items in order, with the transitions between them. */
  function walk(ctx: Ctx, nodes: XmlNode[], parent: Frame, win: Span, lane: number) {
    let previous: Placed[] = [], pending: XmlNode | undefined, outgoing: Placed[] = [];
    for (const node of nodes) {
      if (node.name === 'transition') { pending = node; outgoing = previous; continue; }
      if (!ITEMS.has(node.name)) { if (!QUIET.has(node.name)) skip(node.name); continue; }
      const own = item(ctx, node, parent, win, lane + laneOf(node));
      if (pending) { transition(ctx, pending, parent, outgoing, own); pending = undefined; }
      previous = own;
    }
    if (pending) transition(ctx, pending, parent, outgoing, []);
  }

  /** Places one story element; returns the clips it put on its own lane (what a transition joins). */
  function item(ctx: Ctx, node: XmlNode, parent: Frame, win: Span, lane: number): Placed[] {
    switch (node.name) {
      case 'spine': walk(ctx, node.children, { origin: at(parent, fcpTime(node.attrs.offset)), start: fcpTime(node.attrs.start), rate: parent.rate }, win, lane); return [];
      case 'gap': {
        const own = { origin: at(parent, fcpTime(node.attrs.offset)), start: fcpTime(node.attrs.start), rate: parent.rate };
        connected(ctx, node, own, win, lane); markers(ctx, node, own);
        return [];
      }
      case 'audition': {
        const picks = node.children.filter(c => ITEMS.has(c.name));
        if (picks.length > 1) gap('Auditions import their active pick only');
        // The audition holds the timing; its picks have none of their own.
        return picks[0] ? item(ctx, { ...picks[0], attrs: { ...picks[0].attrs, offset: node.attrs.offset ?? picks[0].attrs.offset ?? '0s' } }, parent, win, lane) : [];
      }
      case 'title': return title(ctx, node, parent, win, lane);
      case 'ref-clip': case 'mc-clip': return composite(ctx, node, parent, win, lane);
      case 'clip': case 'sync-clip': return container(ctx, node, parent, win, lane);
      default: return source(ctx, node, parent, win, lane);
    }
  }

  /** Connected clips and storylines hang off an item in its local time and are not cut to its length. */
  function connected(ctx: Ctx, node: XmlNode, own: Frame, win: Span, lane: number) {
    ctx.depth++;
    for (const c of node.children) if (ITEMS.has(c.name)) item(ctx, c, own, win, lane + laneOf(c)); else if (UNREAD.has(c.name)) skip(c.name);
    ctx.depth--;
  }

  function markers(ctx: Ctx, node: XmlNode, own: Frame, span?: Span) {
    for (const m of node.children) {
      if (m.name !== 'marker' && m.name !== 'chapter-marker') continue;
      const time = frame(ctx, at(own, fcpTime(m.attrs.start)));
      if (time < 0 || (span && (time < span.lo - 1e-6 || time > span.hi + 1e-6))) continue;
      ctx.markers.push({ id: id('marker', `${ctx.timeline.id}/${ctx.markers.length}`), time, name: (m.attrs.value || 'Marker').slice(0, 255),
        color: m.name === 'chapter-marker' ? 'Orange' : m.attrs.completed === '0' ? 'Red' : m.attrs.completed === '1' ? 'Green' : 'Blue', ...(m.attrs.note ? { note: m.attrs.note.slice(0, 5000) } : {}) });
    }
  }

  /** An element's timeMap as media time of local time (identity without one). */
  function timeMap(node: XmlNode) {
    const points = child(node, 'timeMap')?.children.filter(c => c.name === 'timept').map(p => ({ t: fcpTime(p.attrs.time), v: fcpTime(p.attrs.value), smooth: /smooth/.test(p.attrs.interp ?? '') })).sort((a, b) => a.t - b.t) ?? [];
    const map = (t: number) => {
      if (points.length < 2) return points.length ? points[0].v + t - points[0].t : t;
      let i = points.findIndex(p => p.t > t) - 1;
      if (i < 0) i = t < points[0].t ? 0 : points.length - 2;
      const a = points[Math.min(i, points.length - 2)], b = points[Math.min(i, points.length - 2) + 1];
      return b.t === a.t ? a.v : a.v + (t - a.t) * (b.v - a.v) / (b.t - a.t);
    };
    return { points, map, retimed: points.length > 1 };
  }

  /**
   * Media seconds per local second from a rate conform. Unless scaleEnabled="0", Final Cut plays each source frame on
   * one frame of the timeline rate, or of twice or half it when that is nearer (25p in 24p at 96%, 50p in 23.98 at 95.9%).
   */
  function conformFactor(ctx: Ctx, node: XmlNode) {
    const conform = child(node, 'conform-rate'), rate = conform?.attrs.srcFrameRate;
    if (!conform || conform.attrs.scaleEnabled === '0' || !rate) return 1;
    const source = NTSC[rate] ?? Number(rate);
    if (!(source > 0)) { gap(`Rate conform "${rate}" is not imported`); return 1; }
    const target = ctx.fps * 2 ** Math.round(Math.log2(source / ctx.fps));
    return Math.abs(target / source - 1) < 1e-3 ? 1 : target / source;
  }

  /**
   * Source position and speed over a clip's visible span. Speed segments between time points become hold keyframes
   * on speed / reverse / freeze, which SharedCut integrates; the source starts at the lowest media time the clip
   * reaches, because a reversed clip plays down to it.
   */
  function retime(ctx: Ctx, node: XmlNode, own: Frame, span: Span, mediaStart: number, label: string): Adjusted & { sourceIn: number } {
    // A rate conform scales the media's advance about the element's start, where local and media time agree.
    const { points, map: mapped } = timeMap(node), factor = conformFactor(ctx, node), anchor = mapped(fcpTime(node.attrs.start, mediaStart));
    const map = factor === 1 ? mapped : (t: number) => anchor + (mapped(t) - anchor) * factor;
    const local = (t: number) => own.start + (t - own.origin) / own.rate, l0 = local(span.lo), l1 = local(span.hi);
    const cuts = [l0, ...points.map(p => p.t).filter(t => t > l0 + 1e-9 && t < l1 - 1e-9), l1];
    const segments = cuts.slice(1).map((b, i) => ({ time: (cuts[i] - l0) * own.rate, slope: (map(b) - map(cuts[i])) / (b - cuts[i]) / own.rate }));
    const result: Adjusted & { sourceIn: number } = { sourceIn: Math.min(...cuts.map(map)) - mediaStart, properties: {}, keyframes: {}, effects: [], grades: [] };
    const speed = (slope: number) => {
      const percent = Math.abs(slope) * 100;
      if (slope && (percent < 1 || percent > 800)) gap(`Speeds outside 1–800% are clamped (${label})`);
      return slope ? round(Math.min(800, Math.max(1, percent))) : 100;
    };
    if (segments.every(s => Math.abs(s.slope - segments[0].slope) < 1e-4)) {
      const slope = segments[0].slope;
      if (Math.abs(slope) < 1e-6) { result.properties.freeze = true; result.sourceIn = map(l0) - mediaStart; }
      else { if (Math.abs(slope - 1) > 1e-6) result.properties.speed = speed(slope); if (slope < 0) result.properties.reverse = true; }
    } else {
      const hold = (value: number | boolean, i: number, name: string): Keyframe => ({ id: `${name}-${i}`, time: round(segments[i].time), value, interpolation: 'hold' });
      result.keyframes['properties.speed'] = segments.map((s, i) => hold(speed(s.slope), i, 'speed'));
      if (segments.some(s => s.slope < -1e-6)) result.keyframes['properties.reverse'] = segments.map((s, i) => hold(s.slope < -1e-6, i, 'reverse'));
      if (segments.some(s => Math.abs(s.slope) < 1e-6)) result.keyframes['properties.freeze'] = segments.map((s, i) => hold(Math.abs(s.slope) < 1e-6, i, 'freeze'));
      result.properties.speed = Number(result.keyframes['properties.speed'][0].value);
      if (points.some(p => p.smooth)) gap('Eased speed ramps import as instant speed changes');
    }
    if (result.sourceIn < -1 / ctx.fps) gap(`Clips starting before their media begin at its first frame (${label})`);
    result.sourceIn = Math.max(0, result.sourceIn);
    return result;
  }

  /** One animatable parameter → a static property and/or keyframes, converted and clamped as the editor does. */
  function animate(target: Adjusted, owner: XmlNode | undefined, name: string, outputs: [string, (value: string) => number, number][], relative: (local: number) => number) {
    if (!owner) return;
    const p = param(owner, name), value = owner.attrs[name] ?? p?.attrs.value, frames = keyNodes(p);
    for (const [property, convert, neutral] of outputs) {
      const path = `properties.${property}`, bounded = (v: string) => round(Number(boundedAnimationValue(path, convert(v))));
      if (frames.length) {
        const keys: Keyframe[] = [];
        for (const k of frames) {
          const time = round(relative(fcpTime(k.attrs.time)));
          if (keys.length && time <= keys[keys.length - 1].time) continue;
          const curve = EASE[k.attrs.interp ?? ''];
          keys.push({ id: `${property}-${keys.length}`, time, value: bounded(k.attrs.value ?? value ?? String(neutral)), interpolation: curve ? 'bezier' : 'linear', ...(curve ? { curve } : {}) });
        }
        target.keyframes[path] = keys;
        target.properties[property] = keys[0].value;
      } else if (value !== undefined) {
        const v = bounded(value);
        if (Math.abs(v - neutral) > 1e-9) target.properties[property] = v;
      }
    }
  }

  /** Transform, crop, opacity, blend mode and spatial conform of a picture. */
  function picture(ctx: Ctx, node: XmlNode, own: Frame, span: Span, label: string, sourceSize?: { width: number; height: number }): Adjusted {
    const out: Adjusted = { properties: {}, keyframes: {}, effects: [], grades: [] }, H = ctx.height / 100;
    const relative = (local: number) => (local - own.start) * own.rate + own.origin - span.lo;
    const transform = child(node, 'adjust-transform');
    // Final Cut flips with a negative scale inside its transform, after the crop; SharedCut flips the picture first.
    const [sx, sy] = pair(transform?.attrs.scale ?? param(transform, 'scale')?.attrs.value ?? '1 1'), flip = sx < 0 ? -1 : 1;
    if (transform) {
      const anchor = pair(transform.attrs.anchor ?? param(transform, 'anchor')?.attrs.value);
      if (keyNodes(param(transform, 'anchor')).length) gap(`Animated anchor points import as their first value (${label})`);
      // Final Cut puts the anchor at `position`; SharedCut turns about the anchor but places by x, so x = position - anchor
      // (the anchor of a flipped picture mirrored).
      animate(out, transform, 'position', [['x', v => (pair(v)[0] - flip * anchor[0]) * H, 0], ['y', v => -(pair(v)[1] - anchor[1]) * H, 0]], relative);
      // A uniform scale is Zoom; an uneven one keys Scale X and Scale Y per axis, so each eases exactly as Final Cut's does.
      const uneven = [transform.attrs.scale ?? param(transform, 'scale')?.attrs.value, ...keyNodes(param(transform, 'scale')).map(k => k.attrs.value)]
        .some(v => { const [a, b] = pair(v); return v !== undefined && Math.abs(Math.abs(a) - Math.abs(b)) > 1e-4; });
      const axis = (i: 0 | 1) => (v: string) => { const s = Math.abs(pair(v)[i]) * 100; if (s < 1 || s > 800) gap(`Scale beyond 1–800% is clamped (${label})`); return s; };
      animate(out, transform, 'scale', uneven ? [['scaleX', axis(0), 100], ['scaleY', axis(1), 100]] : [['zoom', axis(0), 100]], relative);
      // A static angle past a full turn is the same picture within one; SharedCut keys at most ±360°.
      const spins = keyNodes(param(transform, 'rotation'));
      animate(out, transform, 'rotation', [['rotation', v => -(spins.length ? Number(v) : Number(v) % 360), 0]], relative);
      if (spins.some(k => Math.abs(Number(k.attrs.value)) > 360)) gap(`Rotations beyond ±360° are clamped (${label})`);
      if (anchor[0]) out.properties.anchorX = round(flip * anchor[0] * H);
      if (anchor[1]) out.properties.anchorY = round(-anchor[1] * H);
      if (sx < 0) out.properties.flipH = true;
      if (sy < 0) gap(`Vertical flips are not imported (${label})`);
    }
    const crop = child(node, 'adjust-crop');
    if (crop) {
      const mode = crop.attrs.mode ?? 'trim', rect = child(crop, mode === 'crop' ? 'crop-rect' : mode === 'pan' ? 'pan-rect' : 'trim-rect');
      // Final Cut trims the picture's own edges in percent of its height; SharedCut crops the project frame the picture
      // is fitted into, after its flip.
      const fit = sourceSize?.width && sourceSize.height ? Math.min(ctx.width / sourceSize.width, ctx.height / sourceSize.height) : 0;
      const unit = fit ? sourceSize!.height * fit / 100 : H, across = fit ? (ctx.width - sourceSize!.width * fit) / 2 : 0, down = fit ? (ctx.height - sourceSize!.height * fit) / 2 : 0;
      if (mode === 'pan') gap(`Ken Burns crops are not imported (${label})`);
      else if (rect) for (const side of ['left', 'right', 'top', 'bottom']) {
        const shown = flip < 0 && side === 'left' ? 'right' : flip < 0 && side === 'right' ? 'left' : side, property = `crop${shown[0].toUpperCase()}${shown.slice(1)}`;
        const margin = side === 'left' || side === 'right' ? across : down;
        animate(out, rect, side, [[property, v => margin + Math.max(0, Number(v)) * unit, 0]], relative);
        if (!out.keyframes[`properties.${property}`] && Math.abs(Number(out.properties[property] ?? 0) - round(margin)) < 1e-6) delete out.properties[property];
      }
      if (mode === 'crop') gap(`Crop (zoom to fill) imports as a trim crop; check its framing (${label})`);
    }
    const blend = child(node, 'adjust-blend');
    if (blend) {
      animate(out, blend, 'amount', [['opacity', v => Number(v) * 100, 100]], relative);
      const mode = blend.attrs.mode?.trim(), name = mode && (BLENDS[/^\d+/.exec(mode)?.[0] ?? ''] ?? blendModeNames.find(n => n.toLowerCase() === mode.toLowerCase()));
      if (name && name !== 'Normal') out.properties.blendMode = name;
      else if (mode && !name) gap(`Blend mode "${mode}" is not imported`);
    }
    const conform = child(node, 'adjust-conform')?.attrs.type ?? 'fit';
    if (conform !== 'fit') {
      if (!sourceSize?.width || !sourceSize.height) gap(`Spatial conform "${conform}" needs the source size (${label})`);
      else {
        const fit = Math.min(ctx.width / sourceSize.width, ctx.height / sourceSize.height);
        const factor = conform === 'fill' ? Math.max(ctx.width / sourceSize.width, ctx.height / sourceSize.height) / fit : 1 / fit;
        const zoom = (v: number) => round(Math.min(800, Math.max(1, v * factor)));
        out.properties.zoom = zoom(Number(out.properties.zoom ?? 100));
        for (const key of out.keyframes['properties.zoom'] ?? []) key.value = zoom(Number(key.value));
      }
    }
    const effect = (c: XmlNode, on: boolean) => {
      const name = c.attrs.name ?? resources.get(c.attrs.ref ?? '')?.attrs.name ?? 'unnamed', enabled = on && c.attrs.enabled !== '0';
      const cdl = c.children.find(n => n.name === '#comment' && /info-asc-cdl/.test(n.text))?.text, mapped = EFFECTS[name];
      if (cdl) out.grades.push(colorCorrection(c, cdl, name, enabled, label));
      else if (mapped) out.effects.push({ name: mapped.name, enabled, amount: mapped.amount(Number(param(c, 'Amount')?.attrs.value ?? 1)) });
      else gap(`Effect "${name}" is not imported yet`);
    };
    for (const c of node.children) {
      if (c.name === 'filter-video') effect(c, true);
      // A masked effect: the one inside its shape or colour mask applies to the whole picture (the optional second one
      // corrects outside the mask and is left out).
      else if (c.name === 'filter-video-mask') {
        const inside = child(c, 'filter-video');
        if (inside) { gap(`Masked effects import without their mask (${label})`); effect(inside, c.attrs.enabled !== '0'); }
      }
      else if (/^adjust-/.test(c.name) && !QUIET.has(c.name) && !/^adjust-(EQ|matchEQ|loudness|noiseReduction|humReduction|voiceIsolation)/.test(c.name)) gap(`Adjustment "${c.name.replace('adjust-', '')}" is not imported yet`);
    }
    return out;
  }

  /**
   * A Final Cut color correction as a SharedCut grade node. Final Cut writes the correction's exact ASC CDL beside it;
   * (slope·v + offset)^power = slope^power · (v + offset/slope)^power, which is the node's
   * (v + offset)^(1/2^gamma) · gain per channel. Color board saturation pucks run 0–1 with 0.5 unchanged (±100%).
   */
  function colorCorrection(filter: XmlNode, comment: string, name: string, enabled: boolean, label: string): Grade {
    const triple = (key: string, neutral: number) => {
      const values = (new RegExp(`${key}="([^"]*)"`).exec(comment)?.[1] ?? '').trim().split(/\s+/).map(Number).filter(Number.isFinite);
      return [0, 1, 2].map(i => values[i] ?? values[0] ?? neutral);
    };
    const slope = triple('slope', 1), offset = triple('offset', 0), power = triple('power', 1), parameters: Record<string, number> = { exposure: 0, contrast: 1, saturation: 100 };
    const bounded = (v: number) => { if (Math.abs(v) > 2) gap(`Extreme color corrections are clamped (${label})`); return round(Math.max(-2, Math.min(2, v))); };
    [...'RGB'].forEach((c, i) => {
      const s = Math.max(1e-6, slope[i]), p = Math.max(1e-6, power[i]);
      parameters['offset' + c] = bounded(offset[i] / s); parameters['gamma' + c] = bounded(-Math.log2(p)); parameters['gain' + c] = bounded(s ** p - 1);
    });
    const saturation = (key: string) => { const v = Number(param(filter, key)?.attrs.value); return Number.isFinite(v) ? 1 + (v - .5) * 2 : 1; };
    const percent = (key: string) => round(Math.min(400, Math.max(0, 100 * saturation(key))));
    parameters.saturation = percent('Saturation Global');
    for (const range of ['Shadows', 'Midtones', 'Highlights']) { const v = percent(`Saturation ${range}`); if (v !== 100) parameters[`saturation${range}`] = v; }
    if (filter.children.some(p => p.name === 'param' && keyNodes(p).length)) gap(`Animated color corrections import as their first value (${label})`);
    return { name: name.slice(0, 80), kind: 'balance', enabled, parameters };
  }

  /** Volume (dB), pan and fade handles of a sound. */
  function sound(node: XmlNode, own: Frame, span: Span): Adjusted {
    const out: Adjusted = { properties: {}, keyframes: {}, effects: [], grades: [] };
    const relative = (local: number) => (local - own.start) * own.rate + own.origin - span.lo;
    const volume = child(node, 'adjust-volume');
    animate(out, volume, 'amount', [['gain', decibels, 0]], relative);
    for (const [element, property] of [['fadeIn', 'audioFadeIn'], ['fadeOut', 'audioFadeOut']]) {
      const fade = child(param(volume, 'amount'), element);
      if (fade) out.properties[property] = round(Math.min(span.hi - span.lo, fcpTime(fade.attrs.duration) * own.rate));
      // Final Cut eases a fade unless it is set to linear; SharedCut's fades are linear.
      if (fade && fade.attrs.type !== 'linear') gap('Audio fades import with a linear shape, not Final Cut\'s curve');
    }
    animate(out, child(node, 'adjust-panner'), 'amount', [['pan', Number, 0]], relative);
    for (const c of node.children) {
      if (c.name === 'filter-audio') gap(`Audio effect "${c.attrs.name ?? resources.get(c.attrs.ref ?? '')?.attrs.name ?? 'unnamed'}" is not imported yet`);
      else if (/^adjust-(EQ|matchEQ|loudness|noiseReduction|humReduction|voiceIsolation)/.test(c.name)) gap(`Audio enhancement "${c.name.replace('adjust-', '')}" is not imported yet`);
    }
    return out;
  }

  /** Final Cut's audio configuration: sound plays unless every channel or role listed is switched off. SharedCut plays a
   *  source's channels together, so switching off only some of them is reported. */
  const audioOn = (node: XmlNode | undefined, label: string) => {
    const sources = node?.children.filter(c => c.name === 'audio-channel-source' || c.name === 'audio-role-source') ?? [], on = sources.filter(c => c.attrs.active !== '0' && c.attrs.enabled !== '0');
    if (on.length && on.length < sources.length) gap(`Audio channels or roles switched off in Final Cut still play: SharedCut plays a source's channels together (${label})`);
    return !sources.length || on.length > 0;
  };
  /** Volume and pan set per role (on a compound clip or a multicam angle) onto the clip's own mix. */
  const roleMix = (mix: Adjusted, owner: XmlNode | undefined, own: Frame, span: Span, label: string) => {
    const tuned = owner?.children.filter(r => r.name === 'audio-role-source' && r.attrs.active !== '0' && r.attrs.enabled !== '0' && (child(r, 'adjust-volume') || child(r, 'adjust-panner'))) ?? [];
    if (tuned.length > 1) gap(`Volume set per audio role imports as the first role's (${label})`);
    if (!tuned.length) return mix;
    const role = sound(tuned[0], own, span), gain = Number(mix.properties.gain ?? 0) + Number(role.properties.gain ?? 0);
    return { ...mix, properties: { ...role.properties, ...mix.properties, ...(gain ? { gain: Math.max(-60, Math.min(12, gain)) } : {}) }, keyframes: { ...role.keyframes, ...mix.keyframes } };
  };

  /** asset-clip, video, audio: part of a source file. Video with sound becomes a picture clip and a linked audio clip. */
  function source(ctx: Ctx, node: XmlNode, parent: Frame, win: Span, lane: number): Placed[] {
    const ref = resources.get(node.attrs.ref ?? ''), asset = ref?.name === 'asset' ? mediaFor(ref) : undefined, mediaStart = ref?.name === 'asset' ? fcpTime(ref.attrs.start) : 0;
    const label = nameOf(node.attrs.name, ref?.attrs.name, asset?.name, node.name);
    const begin = at(parent, fcpTime(node.attrs.offset)), own: Frame = { origin: begin, start: fcpTime(node.attrs.start, mediaStart), rate: parent.rate };
    // An asset-clip may leave its duration out: it then runs to the end of its asset.
    const duration = node.attrs.duration === undefined && node.name === 'asset-clip' && asset ? Math.max(0, (fcpTime(ref!.attrs.duration) + mediaStart - own.start) / conformFactor(ctx, node)) : fcpTime(node.attrs.duration);
    const span = asset && visible(ctx, begin, duration * parent.rate, win), out: Placed[] = [];
    if (!asset) gap(ref?.name === 'effect' ? `Generator "${ref.attrs.name ?? 'unnamed'}" is not imported yet` : `Items without a source file are skipped (${label})`);
    if (asset) {
      const wantVideo = asset.kind !== 'audio' && node.name !== 'audio' && node.attrs.srcEnable !== 'audio';
      const wantAudio = !!asset.hasAudio && node.name !== 'video' && node.attrs.srcEnable !== 'video' && audioOn(node, label);
      // A split edit (J or L cut) gives the sound its own range, in the same local time; inside a wrapper with one, the
      // wrapper's sound range cuts it. Sound alone is cut to the sample, as Final Cut cuts it (a censor beep lands
      // mid-frame); sound linked to picture follows its frames.
      const split = splitEdit(node), soundWin = ctx.soundWin ?? win;
      const soundOwn: Frame = split ? { origin: at(own, fcpTime(node.attrs.audioStart, own.start)), start: fcpTime(node.attrs.audioStart, own.start), rate: parent.rate } : own;
      const soundSpan = split || !wantVideo ? visible(ctx, soundOwn.origin, (node.attrs.audioDuration !== undefined ? fcpTime(node.attrs.audioDuration) : duration) * parent.rate, soundWin, true)
        : ctx.soundWin ? visible(ctx, begin, duration * parent.rate, soundWin) : span;
      const linked = wantVideo && wantAudio && span && soundSpan ? link(ctx) : undefined, disabled = node.attrs.enabled === '0';
      if (wantVideo && span) {
        const timing = asset.kind === 'image' ? { sourceIn: 0, properties: {}, keyframes: {} } : retime(ctx, node, own, span, mediaStart, label);
        const f = format(ref!.attrs.format), look = picture(ctx, node, own, span, label, f.width ? f : undefined);
        // SharedCut plays a video clip's own sound unless audioDetached; here sound always travels as its own clip.
        out.push(place(ctx, 'video', lane, { mediaId: asset.id, name: label.slice(0, 255), start: span.lo, duration: span.hi - span.lo, sourceIn: round(timing.sourceIn), disabled, color: '#668b9e',
          properties: { ...timing.properties, ...look.properties, ...(asset.hasAudio ? { audioDetached: true } : {}), ...(linked ? { linkGroup: linked } : {}) }, keyframes: { ...timing.keyframes, ...look.keyframes } }, look));
      }
      if (wantAudio && soundSpan) {
        const timing = retime(ctx, node, soundOwn, soundSpan, mediaStart, label), mix = sound(node, soundOwn, soundSpan);
        // Final Cut's -96 dB is silence and SharedCut's floor is -60 dB, so a clip turned all the way down arrives switched off.
        const silent = !mix.keyframes['properties.gain'] && Number(mix.properties.gain ?? 0) <= -60;
        // Each <audio srcCh> component picks channels of one file; SharedCut plays a file's channels together, so the
        // components over the same stretch of it become one clip (one per channel would stack the whole file).
        const sourceIn = round(timing.sourceIn), twin = node.attrs.srcCh !== undefined ? ctx.placed.find(p => p.channel && p.clip.mediaId === asset.id && Math.abs(p.clip.start - soundSpan.lo) < 1e-6 && Math.abs(p.clip.duration - (soundSpan.hi - soundSpan.lo)) < 1e-6 && Math.abs(p.clip.sourceIn - sourceIn) < 1e-6) : undefined;
        if (twin) {
          gap(`Audio channel components of one file import as one clip that plays all its channels (${label})`);
          if (!disabled && !silent) twin.clip.disabled = false;
        } else {
          const placed = place(ctx, 'audio', lane, { mediaId: asset.id, name: label.slice(0, 255), start: soundSpan.lo, duration: soundSpan.hi - soundSpan.lo, sourceIn, disabled: disabled || silent, color: '#699781',
            properties: { ...timing.properties, ...mix.properties, ...(linked ? { linkGroup: linked } : {}) }, keyframes: { ...timing.keyframes, ...mix.keyframes } }, mix);
          Object.assign(placed, { split, channel: node.attrs.srcCh !== undefined });
          out.push(placed);
        }
      }
    }
    connected(ctx, node, own, win, lane);
    markers(ctx, node, own, span);
    return out;
  }

  /** What a wrapper's picture is fitted from: its own format, else its first picture component's. */
  function sourceSize(node: XmlNode): { width: number; height: number } | undefined {
    const ref = resources.get(node.attrs.ref ?? ''), f = format(node.attrs.format ?? (ref?.name === 'asset' ? ref.attrs.format : undefined));
    if (f.width && f.height) return f;
    for (const c of node.children) if (ITEMS.has(c.name) && c.name !== 'audio' && !laneOf(c)) { const size = sourceSize(c); if (size) return size; }
  }

  /**
   * clip / sync-clip: a wrapper around components (video, audio, a storyline) in its own local time, flattened into the
   * timeline and cut to the wrapper's length (its sound to its own range in a J or L cut). Its adjustments and audio
   * configuration carry down to the clips its components produced. Its other lanes are clips connected to it, which keep
   * their own.
   */
  function container(ctx: Ctx, node: XmlNode, parent: Frame, win: Span, lane: number): Placed[] {
    const label = nameOf(node.attrs.name, node.name), begin = at(parent, fcpTime(node.attrs.offset)), start = fcpTime(node.attrs.start);
    const own: Frame = { origin: begin, start, rate: parent.rate }, span = visible(ctx, begin, fcpTime(node.attrs.duration) * parent.rate, win);
    const split = splitEdit(node), soundStart = fcpTime(node.attrs.audioStart, start);
    const soundSpan = visible(ctx, at(own, soundStart), fcpTime(node.attrs.audioDuration ?? node.attrs.duration) * parent.rate, ctx.soundWin ?? win, split);
    const { points, map, retimed } = timeMap(node);
    let slope = 1;
    if (retimed) {
      const a = points[0], b = points[points.length - 1];
      slope = (b.v - a.v) / (b.t - a.t || 1);
      if (points.length > 2 || !(slope > 0)) { gap(`Speed ramps, freezes and reverses on wrapped clips import at constant speed (${label})`); slope = Math.abs(slope) || 1; }
    }
    // Components sit in media time; a retimed or rate-conformed wrapper stretches them.
    const inner: Frame = { origin: begin, start: retimed ? map(start) : start, rate: parent.rate / (slope * conformFactor(ctx, node)) };
    const out: Placed[] = [], parts: Placed[] = [], depth = ctx.depth, outer = ctx.soundWin;
    for (const c of node.children) {
      if (!ITEMS.has(c.name)) { if (UNREAD.has(c.name)) skip(c.name); continue; }
      // A clip's sound may sit on a lane below it; a sync clip's synced sound hangs off its storyline instead.
      const component = c.name === 'video' || c.name === 'audio' || !laneOf(c) || (node.name === 'clip' && laneOf(c) < 0);
      if (!component) { item(ctx, c, own, win, lane + laneOf(c)); continue; }
      if (!span && !soundSpan) continue;
      const from = ctx.placed.length;
      ctx.soundWin = soundSpan ?? { lo: begin, hi: begin }; ctx.depth = depth + (laneOf(c) ? 1 : 0);
      out.push(...item(ctx, c, inner, span ?? { lo: begin, hi: begin }, lane));
      ctx.soundWin = outer; ctx.depth = depth;
      parts.push(...ctx.placed.slice(from));
    }
    const look = span && picture(ctx, node, own, span, label, sourceSize(node)), mix = soundSpan && sound(node, own, soundSpan);
    for (const p of parts) {
      const range = p.kind === 'video' ? span : soundSpan;
      if (!range || p.clip.start < range.lo - 1e-6 || p.clip.start + p.clip.duration > range.hi + 1e-6) continue;
      merge(p.clip, (p.kind === 'video' ? look : mix)!, range.lo - p.clip.start, label);
      if (node.attrs.enabled === '0') p.clip.disabled = true;
      if (split && p.kind === 'audio') p.split = true;
    }
    // Final Cut's audio configuration: the wrapper's own channels, and a sync clip's storyline and connected sources.
    const off = (on: boolean, from: (p: Placed) => boolean) => { if (!on) for (const p of parts) if (p.kind === 'audio' && from(p)) p.clip.disabled = true; };
    off(audioOn(node, label), () => true);
    for (const s of node.children) if (s.name === 'sync-source') off(audioOn(s, label), p => (p.depth > depth) === (s.attrs.sourceID === 'connected'));
    const sounds = parts.filter(p => p.kind === 'audio');
    if (parts.some(p => p.kind === 'video') && sounds.length) {
      const linked = link(ctx);
      for (const p of parts) {
        p.clip.properties.linkGroup = linked;
        if (p.kind === 'video' && mediaById.get(p.clip.mediaId)?.hasAudio) p.clip.properties.audioDetached = true;
      }
    }
    markers(ctx, node, own, span);
    // A transition joins the wrapper's storyline picture and every sound it is made of.
    return [...parts.filter(p => p.kind === 'video' && (p.depth === depth || out.includes(p))), ...sounds];
  }

  /** A wrapper's adjustments onto a clip it produced: the clip's own win, decibels add. */
  function merge(clip: Clip, from: Adjusted, shift: number, label: string) {
    for (const [key, value] of Object.entries(from.properties)) {
      if (clip.properties[key] === undefined) clip.properties[key] = value;
      else if (key === 'gain' && !clip.keyframes?.['properties.gain'] && !from.keyframes['properties.gain']) clip.properties.gain = Math.max(-60, Math.min(12, Number(clip.properties.gain) + Number(value)));
      else gap(`Adjustments on both a wrapped clip and its contents keep the contents' (${label})`);
    }
    for (const [path, keys] of Object.entries(from.keyframes)) {
      if (clip.keyframes?.[path]) continue;
      clip.keyframes = { ...clip.keyframes, [path]: keys.map(k => ({ ...k, time: round(k.time + shift) })) };
    }
    attach(clip, from);
  }

  /**
   * ref-clip (compound) and mc-clip (multicam): a composition clip over a timeline built once per source. Its sound
   * rides on the picture clip unless it comes from elsewhere (another angle, a split edit, no picture at all); then the
   * picture clip is muted and the sound becomes a composition clip of its own on an audio track.
   */
  function composite(ctx: Ctx, node: XmlNode, parent: Frame, win: Span, lane: number): Placed[] {
    const res = resources.get(node.attrs.ref ?? ''), label = nameOf(node.attrs.name, res?.attrs.name, node.name), wanted = node.attrs.srcEnable ?? 'all';
    let shown: Timeline | undefined, heard: Timeline | undefined, origin = 0, look: XmlNode = node, roles: XmlNode | undefined = node;
    if (node.name === 'ref-clip') {
      const sequence = child(res, 'sequence');
      if (sequence) {
        origin = fcpTime(sequence.attrs.tcStart);
        shown = heard = composition(`ref/${res!.attrs.id}`, res!.attrs.name ?? label, sequence.attrs.format, fcpTime(sequence.attrs.duration), c => {
          const spine = child(sequence, 'spine');
          if (spine) walk(c, spine.children, { origin: 0, start: origin, rate: 1 }, { lo: 0, hi: Infinity }, 0);
        });
      }
    } else {
      // The angle supplying the picture also holds the clip's visual adjustments; the one supplying sound, its role volumes.
      const multicam = child(res, 'multicam'), sources = node.children.filter(c => c.name === 'mc-source');
      const video = sources.find(s => ['all', 'video'].includes(s.attrs.srcEnable ?? 'all')), audio = sources.find(s => ['all', 'audio'].includes(s.attrs.srcEnable ?? 'all'));
      // Angle items count from 0, which is the multicam's tcStart; the clip's start is in that timecode.
      const angle = (source: XmlNode | undefined) => {
        const a = source && multicam?.children.find(x => x.name === 'mc-angle' && x.attrs.angleID === source.attrs.angleID);
        return a && composition(`mc/${res!.attrs.id}/${a.attrs.angleID}`, `${res!.attrs.name ?? label} · ${a.attrs.name ?? 'Angle'}`, multicam!.attrs.format, 0,
          c => walk(c, a.children, { origin: 0, start: 0, rate: 1 }, { lo: 0, hi: Infinity }, 0));
      };
      origin = fcpTime(multicam?.attrs.tcStart);
      shown = angle(video); heard = angle(audio); look = video ?? node; roles = audio;
    }
    const begin = at(parent, fcpTime(node.attrs.offset)), own: Frame = { origin: begin, start: fcpTime(node.attrs.start, origin), rate: parent.rate }, duration = fcpTime(node.attrs.duration) * parent.rate;
    const span = visible(ctx, begin, duration, win), split = splitEdit(node), out: Placed[] = [];
    const soundOwn: Frame = split ? { origin: at(own, fcpTime(node.attrs.audioStart, own.start)), start: fcpTime(node.attrs.audioStart, own.start), rate: parent.rate } : own;
    const soundSpan = split ? visible(ctx, soundOwn.origin, fcpTime(node.attrs.audioDuration ?? node.attrs.duration) * parent.rate, ctx.soundWin ?? win, true) : ctx.soundWin ? visible(ctx, begin, duration, ctx.soundWin) : span;
    const pictureOn = !!shown && wanted !== 'audio', soundOn = !!heard && wanted !== 'video' && audioOn(roles, label);
    const apart = soundOn && (!pictureOn || heard !== shown || soundSpan?.lo !== span?.lo || soundSpan?.hi !== span?.hi);
    if (!shown && !heard) gap(`${node.name === 'ref-clip' ? 'Compound' : 'Multicam'} clips with no readable contents are skipped (${label})`);
    const timing = (f: Frame, s: Span) => {
      const t = retime(ctx, node, f, s, origin, label);
      if (t.properties.speed || t.properties.reverse || t.properties.freeze || Object.keys(t.keyframes).length) gap(`Retimed compound and multicam clips import at normal speed (${label})`);
      return round(t.sourceIn);
    };
    const mix = (f: Frame, s: Span) => roleMix(sound(node, f, s), roles, f, s, label);
    const base = { mediaId: 'frameline-composition', name: label.slice(0, 255), color: '#7856b9', disabled: node.attrs.enabled === '0' };
    if (pictureOn && span) {
      const adjusted = picture(ctx, look, own, span, label), carried = soundOn && !apart ? mix(own, span) : undefined;
      out.push(place(ctx, 'video', lane, { ...base, start: span.lo, duration: span.hi - span.lo, sourceIn: timing(own, span),
        properties: { compositionId: shown!.id, ...(carried?.properties ?? { audioDetached: true }), ...adjusted.properties }, keyframes: { ...carried?.keyframes, ...adjusted.keyframes } }, adjusted));
    }
    if (apart && soundSpan) {
      const m = mix(soundOwn, soundSpan), placed = place(ctx, 'audio', lane, { ...base, start: soundSpan.lo, duration: soundSpan.hi - soundSpan.lo, sourceIn: timing(soundOwn, soundSpan),
        properties: { compositionId: heard!.id, ...m.properties }, keyframes: m.keyframes }, m);
      placed.split = split;
      out.push(placed);
    }
    if (out.length > 1) { const linked = link(ctx); for (const p of out) p.clip.properties.linkGroup = linked; }
    connected(ctx, node, own, win, lane);
    markers(ctx, node, own, span);
    return out;
  }

  function composition(key: string, name: string, formatRef: string | undefined, duration: number, fill: (ctx: Ctx) => void) {
    const done = compositions.get(key);
    if (done) return done;
    if (building.has(key)) { gap('A compound clip that contains itself is skipped'); return undefined; }
    if (building.size >= 15) { gap('Compound clips nested deeper than 16 levels are skipped'); return undefined; }
    building.add(key);
    try { const timeline = buildTimeline(key, name, formatRef, duration, true, fill); compositions.set(key, timeline); return timeline; }
    finally { building.delete(key); }
  }

  /**
   * A title as a SharedCut text clip: its words, fonts, sizes, colours and alignment, laid out where the Motion
   * template's text objects sit ("Position" in pixels from the centre, y up; a Paragraph layout's box runs from it to
   * "Right Margin", and a bottom-aligned box ends "Bottom Margin" below it). The template's own graphics and animation
   * are not reproduced.
   */
  function title(ctx: Ctx, node: XmlNode, parent: Frame, win: Span, lane: number): Placed[] {
    const template = nameOf(resources.get(node.attrs.ref ?? '')?.attrs.name, 'Title'), label = nameOf(node.attrs.name, template);
    const begin = at(parent, fcpTime(node.attrs.offset)), own: Frame = { origin: begin, start: fcpTime(node.attrs.start), rate: parent.rate };
    const span = visible(ctx, begin, fcpTime(node.attrs.duration) * parent.rate, win), out: Placed[] = [];
    const styles = new Map(node.children.filter(c => c.name === 'text-style-def').map(d => [d.attrs.id, child(d, 'text-style')]));
    // Each <text> is one of the template's text objects; each becomes its own SharedCut title, as SharedCut sets every
    // line of a title at least as tall as its first run (a big name line would push small lines below it out of the box).
    // Sizes and positions are in the timeline's own pixels.
    const blocks = node.children.filter(c => c.name === 'text').map(text => {
      let tight = false, room = TEXT_LIMIT;
      const runs: TextRun[] = text.children.filter(c => c.name === 'text-style').map(r => {
        const s = styles.get(r.attrs.ref), face = s?.attrs.fontFace ?? '', family = (s?.attrs.font ?? '').replace(/[\x00-\x1f"\\]/g, '').trim().slice(0, 160), size = (Number(s?.attrs.fontSize) || 63) * ctx.scale;
        if (Number(s?.attrs.lineSpacing) < 0) tight = true;
        // One SharedCut text box holds 10,000 characters; a longer text object (a credits roll) is cut there.
        const kept = r.text.slice(0, Math.max(0, room));
        room -= r.text.length;
        return { text: kept, style: { fontFamily: family ? fontFor(family) : defaultTextStyle.fontFamily, fontSize: Math.min(600, Math.max(4, size)),
          fontWeight: s?.attrs.bold === '1' || /bold|black|heavy/i.test(face) ? 700 : /light|thin/i.test(face) ? 300 : /medium/i.test(face) ? 500 : 400,
          // Final Cut's tracking is a percent of the font size; SharedCut's letter spacing is pixels.
          italic: s?.attrs.italic === '1' || /italic|oblique/i.test(face), underline: s?.attrs.underline === '1', letterSpacing: round(Math.min(100, Math.max(-10, (Number(s?.attrs.kerning) || 0) / 100 * size))), color: hex(s?.attrs.fontColor, '#ffffff') } };
      }).filter((r, i) => i === 0 || r.text);
      if (room < 0 || runs.length > 1000) gap(`Title text longer than one SharedCut text box (10,000 characters) is cut (${label})`);
      return { runs: runs.slice(0, 1000), tight };
    }).filter(b => b.runs.some(r => r.text.trim()));
    if (!blocks.length) gap(`Titles with no text are skipped (${template})`);
    else if (span) {
      gap(`Title "${template}" imports as text with its fonts and layout; the template's graphics and animation are not reproduced`);
      const clamp = (lo: number, hi: number, v: number) => Math.min(hi, Math.max(lo, v)), runs = blocks.flatMap(b => b.runs);
      const placement = param(node, 'Alignment')?.attrs.value ?? '', styled = [...styles.values()][0]?.attrs.alignment;
      const align = /Right/.test(placement) ? 'right' : /Left/.test(placement) ? 'left' : /Center/.test(placement) ? 'center' : styled === 'left' || styled === 'right' ? styled : 'center';
      const params = (name: string) => node.children.filter(c => c.name === 'param' && c.attrs.name === name);
      const positions = params('Position').map(c => pair(c.attrs.value).map(v => v * ctx.scale) as [number, number]);
      const lefts = params('Left Margin').map(c => Number(c.attrs.value) * ctx.scale || 0), rights = params('Right Margin').map(c => Number(c.attrs.value) * ctx.scale || 0);
      // Centred and right-aligned text hangs on its Position (a Type layout) or on the middle or right edge of its margins.
      const across = positions.length ? .5 + (positions[0][0] + (!rights.length || align === 'left' ? 0 : align === 'right' ? rights[0] : ((lefts[0] ?? 0) + rights[0]) / 2)) / ctx.width : .5;
      const x = align === 'left' ? (positions.length ? clamp(.03, .6, .5 + Math.min(...positions.map(p => p[0])) / ctx.width) : .05) : clamp(-4, 4, align === 'center' ? across - .45 : positions.length ? across - .9 : .05);
      const width = align === 'left' ? Math.min(.94, .97 - x) : .9;
      // Final Cut breaks lines only where the text does (Auto-Shrink fits them to the margins); SharedCut would wrap
      // at its box instead, so a line wider than the box shrinks the whole title, as Auto-Shrink does.
      const widths: number[] = [];
      if (measure) for (const b of blocks) { widths.push(0); for (const r of b.runs) for (const [k, part] of r.text.split('\n').entries()) { if (k) widths.push(0); widths[widths.length - 1] += part ? measure(part, r.style) : 0; } }
      const fit = Math.min(1, .98 * width * ctx.width / Math.max(1, ...widths));
      if (fit < 1) for (const r of runs) r.style = { ...r.style, fontSize: Math.max(4, round(r.style.fontSize * fit)), letterSpacing: round(r.style.letterSpacing * fit) };
      // Heights as the renderer sets them: each line as tall as its largest run, and never shorter than the first run.
      // Lines set tighter than their font (negative line spacing) keep that pitch, but the box reaches a quarter of a line
      // further down, as the renderer clips to it and the last line's descenders hang below its pitch.
      const heights = blocks.map(b => {
        const lineHeight = b.tight ? 1 : 1.14, lines: number[] = [0], tallest = (size: number) => Math.max(size, b.runs[0].style.fontSize);
        for (const r of b.runs) for (const [k, part] of r.text.split('\n').entries()) { if (k) lines.push(0); if (part) lines[lines.length - 1] = Math.max(lines[lines.length - 1], r.style.fontSize); }
        return { lineHeight, height: lines.reduce((sum, size) => sum + tallest(size) * lineHeight, 0) / ctx.height, descent: b.tight ? .25 * tallest(lines[lines.length - 1]) / ctx.height : 0 };
      });
      const total = heights.reduce((sum, h) => sum + h.height, 0);
      const bottoms = params('Bottom Margin').map((c, i) => (positions[i]?.[1] ?? 0) + Number(c.attrs.value) * ctx.scale);
      let y = /Bottom/.test(placement) && bottoms.length ? .5 - Math.min(...bottoms) / ctx.height - total : .5 - (positions[0]?.[1] ?? 0) / ctx.height - total / 2;
      const look = picture(ctx, node, own, span, label), linked = blocks.length > 1 ? link(ctx) : undefined;
      for (const [i, b] of blocks.entries()) {
        const doc: TextDocument = { ...defaultTextEffects, runs: b.runs, x, y: clamp(-4, 4, y), width, height: clamp(.01, 1, heights[i].height + heights[i].descent), align, lineHeight: heights[i].lineHeight, opacity: 100 };
        y += heights[i].height;
        out.push(place(ctx, 'video', lane, { mediaId: 'frameline-title', name: b.runs.map(r => r.text).join(' ').replace(/\s+/g, ' ').trim().slice(0, 80) || label.slice(0, 80), start: span.lo, duration: span.hi - span.lo, sourceIn: 0, color: '#8e75ba',
          disabled: node.attrs.enabled === '0', properties: { animationPresetDuration: span.hi - span.lo, textDocument: JSON.stringify(doc), ...(linked ? { linkGroup: linked } : {}), ...look.properties }, keyframes: structuredClone(look.keyframes) }, look));
      }
    }
    connected(ctx, node, own, win, lane);
    markers(ctx, node, own, span);
    return out;
  }

  /**
   * A storyline transition. Picture: the incoming clip's transition, aligned where Final Cut put it on the cut; a side
   * with no picture across the cut (a gap, a title's further text objects) takes it on its own edge, over the same
   * window. Sound: SharedCut has no audio transition, so each sound reaches into its handle across Final Cut's window and
   * fades there (a crossfade where both sides have one; the overlap lands on a second audio track). Expanded sound (a J
   * or L cut) takes no crossfade, as in Final Cut.
   */
  function transition(ctx: Ctx, node: XmlNode, parent: Frame, outgoing: Placed[], incoming: Placed[]) {
    const begin = at(parent, fcpTime(node.attrs.offset)), length = Math.min(30, fcpTime(node.attrs.duration) * parent.rate), end = begin + length;
    if (!(length > 0)) return;
    const filter = child(node, 'filter-video'), label = filter?.attrs.name ?? resources.get(filter?.attrs.ref ?? '')?.attrs.name ?? node.attrs.name ?? 'Cross Dissolve';
    let name = TRANSITIONS[label] ?? 'Cross dissolve', params = '{}';
    if (name === 'Dip to black') {
      const colour = hex(param(filter, 'Color')?.attrs.value, '#000000');
      if (colour === '#ffffff') name = 'Dip to white'; else if (colour !== '#000000') { name = 'Dip to colour'; params = JSON.stringify({ colour }); }
    }
    if (!transitionDefinitions[name]) { name = 'Cross dissolve'; params = '{}'; }
    if (!EXACT_TRANSITIONS.has(label)) gap(`Transition "${label}" imports as SharedCut's "${name}"`);
    // The clips on each side's edge: the item's earliest starts and latest ends.
    const edge = (list: Placed[], test: (p: Placed) => boolean, last: boolean) => {
      const at = (p: Placed) => last ? p.clip.start + p.clip.duration : p.clip.start, picked = list.filter(test), t = last ? Math.max(...picked.map(at)) : Math.min(...picked.map(at));
      return picked.filter(p => Math.abs(at(p) - t) < 1e-6).map(p => p.clip);
    };
    const align = (share: number) => share < .25 ? 'in' : share > .75 ? 'out' : 'center';
    const vOut = edge(outgoing, p => p.kind === 'video', true), vIn = edge(incoming, p => p.kind === 'video', false);
    const shared = vOut[0] && vIn[0] && Math.abs(vOut[0].start + vOut[0].duration - vIn[0].start) < 1e-6;
    for (const c of vIn) { c.transition = name; Object.assign(c.properties, { transitionDuration: round(length), transitionAlign: align((c.start - begin) / length), transitionParams: params }); }
    for (const c of vOut) if (!shared || c !== vOut[0]) Object.assign(c.properties, { transitionOut: name, transitionOutDuration: round(length), transitionOutAlign: align((c.start + c.duration - begin) / length), transitionOutParams: params });
    // A switched-off sound has nothing to fade; a composition clip carries its own sound, which fades on its own bounds.
    const audible = (p: Placed) => !p.clip.disabled && (p.kind === 'audio' || (p.clip.mediaId === 'frameline-composition' && !p.clip.properties.audioDetached));
    const aOut = edge(outgoing, audible, true), aIn = edge(incoming, audible, false), sides = [...outgoing, ...incoming].filter(p => aOut.includes(p.clip) || aIn.includes(p.clip));
    if (!sides.length || sides.some(p => p.split)) return;
    gap('Audio fades import with a linear shape, not Final Cut\'s curve');
    const plain = (c: Clip) => !c.properties.reverse && !c.properties.freeze && !c.keyframes?.['properties.speed'];
    const reaches = (c: Clip) => sides.find(p => p.clip === c)!.kind === 'audio' && plain(c);
    // Whole frames only, never past the media's first or last frame. Fade handles win over the transition's crossfade.
    const floor = (t: number) => Math.max(0, Math.floor(t * ctx.fps + 1e-6) / ctx.fps);
    for (const c of aOut) {
      const cut = c.start + c.duration, rate = Number(c.properties.speed ?? 100) / 100, media = c.mediaId === 'frameline-composition' ? Infinity : mediaById.get(c.mediaId)?.duration ?? 0;
      const tail = reaches(c) ? floor(Math.min(end - cut, (media - c.sourceIn) / rate - c.duration)) : 0;
      c.duration = round(c.duration + tail);
      const fade = round(Math.min(c.duration, tail + Math.max(0, cut - begin)));
      if (fade > 0) c.properties.audioFadeOut ??= fade;
    }
    for (const c of aIn) {
      const cut = c.start, rate = Number(c.properties.speed ?? 100) / 100, head = reaches(c) ? floor(Math.min(cut - begin, c.sourceIn / rate)) : 0;
      if (head > 0) {
        c.start = round(c.start - head); c.duration = round(c.duration + head); c.sourceIn = Math.max(0, round(c.sourceIn - head * rate));
        for (const keys of Object.values(c.keyframes ?? {})) for (const k of keys) k.time = round(k.time + head);
      }
      const fade = round(Math.min(c.duration, head + Math.max(0, end - cut)));
      if (fade > 0) c.properties.audioFadeIn ??= fade;
    }
  }

  /**
   * Lanes → tracks. Video stacks by lane (lanes below the storyline first); audio lists the storyline, then lanes
   * above it, then below. A lane whose clips overlap (crossfades, flattened wrappers) takes extra tracks beside it.
   */
  function assignTracks(ctx: Ctx) {
    for (const kind of ['video', 'audio'] as const) {
      const rank = (lane: number) => kind === 'video' || lane >= 0 ? lane : 1e6 - lane;
      const lanes = [...new Set(ctx.placed.filter(p => p.kind === kind).map(p => p.lane))].sort((a, b) => rank(a) - rank(b));
      let number = 0;
      const track = () => {
        number++;
        const t: Track = { id: id('track', `${ctx.timeline.id}/${kind}/${number}`), timelineId: ctx.timeline.id, name: `${kind === 'video' ? 'V' : 'A'}${number}`, kind, number, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 };
        tracks.push(t);
        return t;
      };
      for (const lane of lanes) {
        const rows: { end: number; track: Track }[] = [];
        for (const p of ctx.placed.filter(p => p.kind === kind && p.lane === lane).sort((a, b) => a.clip.start - b.clip.start)) {
          let row = rows.find(r => r.end <= p.clip.start + 1e-6);
          if (!row) rows.push(row = { end: 0, track: track() });
          row.end = p.clip.start + p.clip.duration;
          p.clip.trackId = row.track.id;
        }
      }
      if (!number) track();
    }
  }

  for (const [i, p] of projects.entries()) {
    const sequence = child(p, 'sequence'), spine = child(sequence, 'spine');
    if (!sequence || !spine) { gap(`Project "${p.attrs.name ?? i + 1}" has no timeline and is skipped`); continue; }
    const tcStart = fcpTime(sequence.attrs.tcStart), duration = fcpTime(sequence.attrs.duration);
    buildTimeline(`project/${p.attrs.uid ?? i}`, p.attrs.name ?? `Timeline ${i + 1}`, sequence.attrs.format, duration, false,
      ctx => walk(ctx, spine.children, { origin: 0, start: tcStart, rate: 1 }, { lo: 0, hi: duration > 0 ? duration : Infinity }, 0));
  }
  const main = timelines.find(t => !t.composition);
  if (!main) throw new Error('None of the projects in that XML has a timeline.');
  // Compositions finish building before the edit that uses them; list the edits first so the project opens on one.
  timelines.sort((a, b) => Number(!!a.composition) - Number(!!b.composition));

  const warnings = [...gaps].map(([what, count]) => count > 1 ? `${what} (×${count})` : what).sort();
  const project: Project = { id: projectId, name: nameOf(projects[0].attrs.name, 'Final Cut project').slice(0, 255), description: 'Imported from Final Cut Pro.', shared: false, thumbnail: '', modifiedAt: Date.now(),
    duration: main.duration, resolution: `${projectWidth} × ${projectHeight}`, fps: projectFps, status: 'In progress', members: [{ userId, role: 'Owner' }] };
  Object.assign(project, { fcpImportHash: createHash('sha256').update(xml).digest('hex'), fcpWarnings: warnings.slice(0, 500) });
  return { project, media: [...media.values()], timelines, tracks, clips, nodes, warnings };
}
