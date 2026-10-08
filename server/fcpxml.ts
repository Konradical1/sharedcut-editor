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

/** One id per XML, so importing the same bundle again resumes instead of duplicating. */
export const fcpProjectId = (xml: string) => 'fcp-' + createHash('sha256').update(xml).digest('hex').slice(0, 32);

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
interface Placed { clip: Clip; kind: Kind; lane: number }
type Grade = Pick<GradeNode, 'name' | 'kind' | 'enabled' | 'parameters'>;
interface Adjusted { properties: Clip['properties']; keyframes: Keys; effects: Omit<Effect, 'id'>[]; grades: Grade[] }
interface Ctx { timeline: Timeline; fps: number; width: number; height: number; placed: Placed[]; markers: Marker[]; count: number }

const ITEMS = new Set(['asset-clip', 'clip', 'sync-clip', 'ref-clip', 'mc-clip', 'video', 'audio', 'title', 'gap', 'spine', 'audition']);
// Metadata, and elements their owner reads: never worth a warning on their own.
const QUIET = new Set(['#comment', 'note', 'keyword', 'rating', 'analysis-marker', 'metadata', 'marker', 'chapter-marker', 'transition', 'timeMap', 'conform-rate', 'param', 'text', 'text-style-def', 'mc-source', 'audio-channel-source', 'audio-role-source', 'adjust-transform', 'adjust-crop', 'adjust-blend', 'adjust-volume', 'adjust-panner', 'adjust-conform', 'caption', 'filter-video', 'filter-audio']);
const IMAGE = /\.(png|jpe?g|tiff?|heic|psd|gif|bmp|webp)$/i;
const EASE: Record<string, Curve> = { ease: [.42, 0, .58, 1], easeIn: [.42, 0, 1, 1], easeOut: [0, 0, .58, 1] };
// Final Cut transition → the nearest SharedCut one. Only the first two are the same effect; the rest are named in the report.
const TRANSITIONS: Record<string, string> = { 'Cross Dissolve': 'Cross dissolve', 'Fade To Color': 'Dip to black', Flash: 'Camera flash', 'Zoom & Pan': 'Zoom in', Simple: 'Blur dissolve',
  'Cross Blur': 'Blur dissolve', Gaussian: 'Blur dissolve', Zoom: 'Zoom in', Push: 'Push left', Slide: 'Slide over', Spin: 'Spin', Wipe: 'Linear wipe', Circle: 'Iris', Bloom: 'Glow bleed' };
const EXACT_TRANSITIONS = new Set(['Cross Dissolve', 'Fade To Color']);
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
  const timelines: Timeline[] = [], tracks: Track[] = [], clips: Clip[] = [], nodes: GradeNode[] = [];
  const compositions = new Map<string, Timeline>(), building = new Set<string>();

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
    const f = format(asset.attrs.format), kind = IMAGE.test(path) ? 'image' : asset.attrs.hasVideo === '1' ? 'video' : 'audio';
    item = { id: id('media', path), projectId, name: path.split(/[\\/]/).pop()!.slice(0, 255) || 'Source', kind, binId: kind === 'audio' ? 'audio' : kind === 'image' ? 'graphics' : 'broll', thumbnail: '',
      duration: Math.max(0, fcpTime(asset.attrs.duration)), resolution: f.width ? `${f.width} × ${f.height}` : '', fps: kind === 'video' ? f.fps : 0, size: '', status: 'failed', progress: 0,
      sourcePath: path, hasAudio: asset.attrs.hasAudio === '1', error: 'Source file not uploaded yet. Run the Final Cut import again with its media.' };
    media.set(path, item); mediaById.set(item.id, item);
    return item;
  };

  function buildTimeline(key: string, name: string, formatRef: string | undefined, duration: number, composition: boolean, fill: (ctx: Ctx) => void) {
    const f = format(formatRef);
    const timeline: Timeline = { id: id('timeline', key), projectId, name: name.slice(0, 255) || 'Timeline', duration: 0, ...(composition ? { composition: true } : {}) };
    const ctx: Ctx = { timeline, fps: f.fps || projectFps, width: f.width || projectWidth, height: f.height || projectHeight, placed: [], markers: [], count: 0 };
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
  const place = (ctx: Ctx, kind: Kind, lane: number, clip: Omit<Clip, 'id' | 'projectId' | 'timelineId' | 'trackId' | 'effects'>, look?: Pick<Adjusted, 'effects' | 'grades'>) => {
    const placed: Placed = { kind, lane, clip: { id: id('clip', `${ctx.timeline.id}/${ctx.count++}`), projectId, timelineId: ctx.timeline.id, trackId: '', effects: [], ...clip } };
    if (!Object.keys(placed.clip.keyframes ?? {}).length) delete placed.clip.keyframes;
    if (look) attach(placed.clip, look);
    ctx.placed.push(placed);
    return placed;
  };
  /** Effects and grade nodes onto a clip, after any it already has. */
  const attach = (clip: Clip, look: Pick<Adjusted, 'effects' | 'grades'>) => {
    const start = clip.effects.length, order = nodes.filter(n => n.clipId === clip.id).length;
    clip.effects = [...clip.effects, ...look.effects.map((e, i) => ({ ...e, id: id('effect', `${clip.id}/${start + i}`) }))];
    for (const [i, g] of look.grades.entries()) nodes.push({ ...structuredClone(g), id: id('grade', `${clip.id}/${order + i}`), projectId, clipId: clip.id, order: order + i + 1 });
  };

  /** A storyline: items in order, with the transitions between them. */
  function walk(ctx: Ctx, nodes: XmlNode[], parent: Frame, win: Span, lane: number) {
    let previous: Placed[] = [], pending: XmlNode | undefined, outgoing: Placed[] = [];
    for (const node of nodes) {
      if (node.name === 'transition') { pending = node; outgoing = previous; continue; }
      if (!ITEMS.has(node.name)) { if (!QUIET.has(node.name)) gap(`<${node.name}> is not imported`); continue; }
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
    for (const c of node.children) if (ITEMS.has(c.name)) item(ctx, c, own, win, lane + laneOf(c));
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
   * Source position and speed over a clip's visible span. Speed segments between time points become hold keyframes
   * on speed / reverse / freeze, which SharedCut integrates; the source starts at the lowest media time the clip
   * reaches, because a reversed clip plays down to it.
   */
  function retime(ctx: Ctx, node: XmlNode, own: Frame, span: Span, mediaStart: number, label: string): Adjusted & { sourceIn: number } {
    const { points, map } = timeMap(node);
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
    if (transform) {
      const anchor = pair(transform.attrs.anchor ?? param(transform, 'anchor')?.attrs.value);
      if (keyNodes(param(transform, 'anchor')).length) gap(`Animated anchor points import as their first value (${label})`);
      // Final Cut puts the anchor at `position`; SharedCut turns about the anchor but places by x, so x = position - anchor.
      animate(out, transform, 'position', [['x', v => (pair(v)[0] - anchor[0]) * H, 0], ['y', v => -(pair(v)[1] - anchor[1]) * H, 0]], relative);
      animate(out, transform, 'scale', [['zoom', v => Math.abs(pair(v)[0]) * 100, 100]], relative);
      animate(out, transform, 'rotation', [['rotation', v => -Number(v), 0]], relative);
      if (anchor[0]) out.properties.anchorX = round(anchor[0] * H);
      if (anchor[1]) out.properties.anchorY = round(-anchor[1] * H);
      const [sx, sy] = pair(transform.attrs.scale ?? param(transform, 'scale')?.attrs.value ?? '1 1');
      if (sx < 0) out.properties.flipH = true;
      if (sy < 0) gap(`Vertical flips are not imported (${label})`);
      if (Math.abs(Math.abs(sx) - Math.abs(sy)) > 1e-4) gap(`Non-uniform scale imports as uniform (${label})`);
    }
    const crop = child(node, 'adjust-crop');
    if (crop) {
      const mode = crop.attrs.mode ?? 'trim', rect = child(crop, mode === 'crop' ? 'crop-rect' : mode === 'pan' ? 'pan-rect' : 'trim-rect');
      if (mode === 'pan') gap(`Ken Burns crops are not imported (${label})`);
      else if (rect) for (const side of ['left', 'right', 'top', 'bottom']) animate(out, rect, side, [[`crop${side[0].toUpperCase()}${side.slice(1)}`, v => Math.max(0, Number(v)) * H, 0]], relative);
      if (mode === 'crop') gap(`Crop (zoom to fill) imports as a trim crop; check its framing (${label})`);
    }
    const blend = child(node, 'adjust-blend');
    if (blend) {
      animate(out, blend, 'amount', [['opacity', v => Number(v) * 100, 100]], relative);
      const mode = blend.attrs.mode;
      if (mode && mode !== 'Normal' && mode !== '0') { if (blendModeNames.includes(mode)) out.properties.blendMode = mode; else gap(`Blend mode "${mode}" is not imported`); }
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
    for (const c of node.children) {
      if (c.name === 'filter-video') {
        const name = c.attrs.name ?? resources.get(c.attrs.ref ?? '')?.attrs.name ?? 'unnamed', enabled = c.attrs.enabled !== '0';
        const cdl = c.children.find(n => n.name === '#comment' && /info-asc-cdl/.test(n.text))?.text, mapped = EFFECTS[name];
        if (cdl) out.grades.push(colorCorrection(c, cdl, name, enabled, label));
        else if (mapped) out.effects.push({ name: mapped.name, enabled, amount: mapped.amount(Number(param(c, 'Amount')?.attrs.value ?? 1)) });
        else gap(`Effect "${name}" is not imported yet`);
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
    const ranges = ['Saturation Shadows', 'Saturation Midtones', 'Saturation Highlights'].map(saturation);
    if (ranges.some(v => Math.abs(v - 1) > 1e-3)) gap(`Shadow, midtone and highlight saturation import as one overall saturation (${label})`);
    parameters.saturation = round(Math.min(400, Math.max(0, 100 * saturation('Saturation Global') * (ranges[0] + ranges[1] + ranges[2]) / 3)));
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
    }
    animate(out, child(node, 'adjust-panner'), 'amount', [['pan', Number, 0]], relative);
    for (const c of node.children) {
      if (c.name === 'filter-audio') gap(`Audio effect "${c.attrs.name ?? resources.get(c.attrs.ref ?? '')?.attrs.name ?? 'unnamed'}" is not imported yet`);
      else if (/^adjust-(EQ|matchEQ|loudness|noiseReduction|humReduction|voiceIsolation)/.test(c.name)) gap(`Audio enhancement "${c.name.replace('adjust-', '')}" is not imported yet`);
    }
    return out;
  }

  const audioOn = (node: XmlNode) => {
    const sources = node.children.filter(c => c.name === 'audio-channel-source' || c.name === 'audio-role-source');
    return !sources.length || sources.some(c => c.attrs.active !== '0' && c.attrs.enabled !== '0');
  };

  /** asset-clip, video, audio: part of a source file. Video with sound becomes a picture clip and a linked audio clip. */
  function source(ctx: Ctx, node: XmlNode, parent: Frame, win: Span, lane: number): Placed[] {
    const ref = resources.get(node.attrs.ref ?? ''), asset = ref?.name === 'asset' ? mediaFor(ref) : undefined, mediaStart = ref?.name === 'asset' ? fcpTime(ref.attrs.start) : 0;
    const label = node.attrs.name ?? ref?.attrs.name ?? asset?.name ?? node.name;
    const begin = at(parent, fcpTime(node.attrs.offset)), own: Frame = { origin: begin, start: fcpTime(node.attrs.start, mediaStart), rate: parent.rate };
    const span = asset && visible(ctx, begin, fcpTime(node.attrs.duration) * parent.rate, win), out: Placed[] = [];
    if (!asset) gap(ref?.name === 'effect' ? `Generator "${ref.attrs.name ?? 'unnamed'}" is not imported yet` : `Items without a source file are skipped (${label})`);
    if (asset) {
      const wantVideo = asset.kind !== 'audio' && node.name !== 'audio' && node.attrs.srcEnable !== 'audio';
      const wantAudio = !!asset.hasAudio && node.name !== 'video' && node.attrs.srcEnable !== 'video' && audioOn(node);
      // A split edit (J or L cut) gives the sound its own range, in the same local time.
      // Sound alone is cut to the sample, as Final Cut cuts it (a censor beep lands mid-frame); sound linked to picture follows its frames.
      const split = node.attrs.audioStart !== undefined || node.attrs.audioDuration !== undefined;
      const soundOwn: Frame = split ? { origin: at(own, fcpTime(node.attrs.audioStart, own.start)), start: fcpTime(node.attrs.audioStart, own.start), rate: parent.rate } : own;
      const soundSpan = split || !wantVideo ? visible(ctx, soundOwn.origin, fcpTime(node.attrs.audioDuration ?? node.attrs.duration) * parent.rate, win, true) : span;
      const link = wantVideo && wantAudio && span && soundSpan ? id('link', `${ctx.timeline.id}/${ctx.count}`) : undefined, disabled = node.attrs.enabled === '0';
      if (wantVideo && span) {
        const timing = asset.kind === 'image' ? { sourceIn: 0, properties: {}, keyframes: {} } : retime(ctx, node, own, span, mediaStart, label);
        const f = format(ref!.attrs.format), look = picture(ctx, node, own, span, label, f.width ? f : undefined);
        // SharedCut plays a video clip's own sound unless audioDetached; here sound always travels as its own clip.
        out.push(place(ctx, 'video', lane, { mediaId: asset.id, name: label.slice(0, 255), start: span.lo, duration: span.hi - span.lo, sourceIn: round(timing.sourceIn), disabled, color: '#668b9e',
          properties: { ...timing.properties, ...look.properties, ...(asset.hasAudio ? { audioDetached: true } : {}), ...(link ? { linkGroup: link } : {}) }, keyframes: { ...timing.keyframes, ...look.keyframes } }, look));
      }
      if (wantAudio && soundSpan) {
        const timing = retime(ctx, node, soundOwn, soundSpan, mediaStart, label), mix = sound(node, soundOwn, soundSpan);
        // Final Cut's -96 dB is silence and SharedCut's floor is -60 dB, so a clip turned all the way down arrives switched off.
        const silent = !mix.keyframes['properties.gain'] && Number(mix.properties.gain ?? 0) <= -60;
        out.push(place(ctx, 'audio', lane, { mediaId: asset.id, name: label.slice(0, 255), start: soundSpan.lo, duration: soundSpan.hi - soundSpan.lo, sourceIn: round(timing.sourceIn), disabled: disabled || silent, color: '#699781',
          properties: { ...timing.properties, ...mix.properties, ...(link ? { linkGroup: link } : {}) }, keyframes: { ...timing.keyframes, ...mix.keyframes } }, mix));
      }
    }
    connected(ctx, node, own, win, lane);
    markers(ctx, node, own, span);
    return out;
  }

  /**
   * clip / sync-clip: a wrapper around components (video, audio, a storyline) in its own local time, flattened into the
   * timeline and cut to the wrapper's length. Its adjustments carry down to the clips it produced.
   */
  function container(ctx: Ctx, node: XmlNode, parent: Frame, win: Span, lane: number): Placed[] {
    const label = node.attrs.name ?? node.name, begin = at(parent, fcpTime(node.attrs.offset)), start = fcpTime(node.attrs.start);
    const own: Frame = { origin: begin, start, rate: parent.rate }, span = visible(ctx, begin, fcpTime(node.attrs.duration) * parent.rate, win);
    const { points, map, retimed } = timeMap(node);
    let slope = 1;
    if (retimed) {
      const a = points[0], b = points[points.length - 1];
      slope = (b.v - a.v) / (b.t - a.t || 1);
      if (points.length > 2 || !(slope > 0)) { gap(`Speed ramps, freezes and reverses on wrapped clips import at constant speed (${label})`); slope = Math.abs(slope) || 1; }
    }
    // Components sit in media time; a retimed wrapper stretches them.
    const inner: Frame = { origin: begin, start: retimed ? map(start) : start, rate: parent.rate / slope };
    const out: Placed[] = [], first = ctx.placed.length;
    for (const c of node.children) {
      if (!ITEMS.has(c.name)) continue;
      if (c.name === 'video' || c.name === 'audio' || !c.attrs.lane) { if (span) out.push(...item(ctx, c, inner, span, lane)); }
      else item(ctx, c, own, win, lane + laneOf(c));
    }
    if (span) {
      const look = picture(ctx, node, own, span, label), mix = sound(node, own, span);
      for (const p of ctx.placed.slice(first)) {
        if (p.clip.start < span.lo - 1e-6 || p.clip.start + p.clip.duration > span.hi + 1e-6) continue;
        merge(p.clip, p.kind === 'video' ? look : mix, span.lo - p.clip.start, label);
        if (node.attrs.enabled === '0') p.clip.disabled = true;
      }
      if (out.some(p => p.kind === 'video') && out.some(p => p.kind === 'audio')) {
        const link = id('link', `${ctx.timeline.id}/${ctx.count}`);
        for (const p of out) {
          p.clip.properties.linkGroup = link;
          if (p.kind === 'video' && mediaById.get(p.clip.mediaId)?.hasAudio) p.clip.properties.audioDetached = true;
        }
      }
    }
    markers(ctx, node, own, span);
    return out;
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

  /** ref-clip (compound) and mc-clip (multicam): a composition clip over a timeline built once per source. */
  function composite(ctx: Ctx, node: XmlNode, parent: Frame, win: Span, lane: number): Placed[] {
    const res = resources.get(node.attrs.ref ?? ''), label = node.attrs.name ?? res?.attrs.name ?? node.name;
    let comp: Timeline | undefined, origin = 0;
    if (node.name === 'ref-clip') {
      const sequence = child(res, 'sequence');
      if (sequence) {
        origin = fcpTime(sequence.attrs.tcStart);
        comp = composition(`ref/${res!.attrs.id}`, res!.attrs.name ?? label, sequence.attrs.format, fcpTime(sequence.attrs.duration), c => {
          const spine = child(sequence, 'spine');
          if (spine) walk(c, spine.children, { origin: 0, start: origin, rate: 1 }, { lo: 0, hi: Infinity }, 0);
        });
      }
      if (node.attrs.srcEnable === 'audio') gap(`Audio-only compound clips import as composition clips on a video track (${label})`);
    } else {
      const multicam = child(res, 'multicam'), sources = node.children.filter(c => c.name === 'mc-source');
      const video = sources.find(s => (s.attrs.srcEnable ?? 'all') !== 'audio')?.attrs.angleID, audio = sources.find(s => (s.attrs.srcEnable ?? 'all') !== 'video')?.attrs.angleID;
      const angle = multicam?.children.find(a => a.name === 'mc-angle' && a.attrs.angleID === (video ?? audio));
      if (multicam && angle) {
        origin = fcpTime(multicam.attrs.tcStart);
        comp = composition(`mc/${res!.attrs.id}/${angle.attrs.angleID}`, `${res!.attrs.name ?? label} · ${angle.attrs.name ?? 'Angle'}`, multicam.attrs.format, 0,
          c => walk(c, angle.children, { origin: 0, start: origin, rate: 1 }, { lo: 0, hi: Infinity }, 0));
        if (video && audio && video !== audio) gap(`Multicam clips with sound from another angle use the video angle's sound (${label})`);
      }
    }
    const begin = at(parent, fcpTime(node.attrs.offset)), own: Frame = { origin: begin, start: fcpTime(node.attrs.start, origin), rate: parent.rate };
    const span = comp && visible(ctx, begin, fcpTime(node.attrs.duration) * parent.rate, win), out: Placed[] = [];
    if (!comp) gap(`${node.name === 'ref-clip' ? 'Compound' : 'Multicam'} clips with no readable contents are skipped (${label})`);
    if (comp && span) {
      const timing = retime(ctx, node, own, span, origin, label), look = picture(ctx, node, own, span, label), mix = sound(node, own, span);
      if (timing.properties.speed || timing.properties.reverse || timing.properties.freeze || Object.keys(timing.keyframes).length) gap(`Retimed compound and multicam clips import at normal speed (${label})`);
      out.push(place(ctx, 'video', lane, { mediaId: 'frameline-composition', name: label.slice(0, 255), start: span.lo, duration: span.hi - span.lo, sourceIn: round(timing.sourceIn), color: '#7856b9',
        disabled: node.attrs.enabled === '0', properties: { compositionId: comp.id, ...mix.properties, ...look.properties }, keyframes: { ...mix.keyframes, ...look.keyframes } }, look));
    }
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
   * template's text objects sit ("Position" in pixels from the centre, y up; a bottom-aligned box ends "Bottom Margin"
   * below it). The template's own graphics and animation are not reproduced.
   */
  function title(ctx: Ctx, node: XmlNode, parent: Frame, win: Span, lane: number): Placed[] {
    const template = resources.get(node.attrs.ref ?? '')?.attrs.name ?? 'Title', label = node.attrs.name ?? template;
    const begin = at(parent, fcpTime(node.attrs.offset)), own: Frame = { origin: begin, start: fcpTime(node.attrs.start), rate: parent.rate };
    const span = visible(ctx, begin, fcpTime(node.attrs.duration) * parent.rate, win), out: Placed[] = [];
    const styles = new Map(node.children.filter(c => c.name === 'text-style-def').map(d => [d.attrs.id, child(d, 'text-style')]));
    const runs: TextRun[] = [];
    let tight = false;
    for (const [i, text] of node.children.filter(c => c.name === 'text').entries()) {
      if (i && runs.length) runs.push({ text: '\n', style: runs[runs.length - 1].style });
      for (const r of text.children.filter(c => c.name === 'text-style')) {
        const s = styles.get(r.attrs.ref), face = s?.attrs.fontFace ?? '', family = (s?.attrs.font ?? '').replace(/[\x00-\x1f"\\]/g, '').trim().slice(0, 160);
        if (Number(s?.attrs.lineSpacing) < 0) tight = true;
        runs.push({ text: r.text, style: { fontFamily: family ? fontFor(family) : defaultTextStyle.fontFamily, fontSize: Math.min(600, Math.max(4, Number(s?.attrs.fontSize) || 63)),
          fontWeight: s?.attrs.bold === '1' || /bold|black|heavy/i.test(face) ? 700 : /light|thin/i.test(face) ? 300 : /medium/i.test(face) ? 500 : 400,
          // Final Cut's tracking is a percent of the font size; SharedCut's letter spacing is pixels.
          italic: s?.attrs.italic === '1' || /italic|oblique/i.test(face), underline: s?.attrs.underline === '1', letterSpacing: round(Math.min(100, Math.max(-10, (Number(s?.attrs.kerning) || 0) / 100 * (Number(s?.attrs.fontSize) || 63)))), color: hex(s?.attrs.fontColor, '#ffffff') } });
      }
    }
    const content = runs.map(r => r.text).join('');
    if (!content.trim()) gap(`Titles with no text are skipped (${template})`);
    else if (span) {
      gap(`Title "${template}" imports as text with its fonts and layout; the template's graphics and animation are not reproduced`);
      const clamp = (lo: number, hi: number, v: number) => Math.min(hi, Math.max(lo, v));
      const placement = param(node, 'Alignment')?.attrs.value ?? '', styled = [...styles.values()][0]?.attrs.alignment;
      const align = /Right/.test(placement) ? 'right' : /Left/.test(placement) ? 'left' : /Center/.test(placement) ? 'center' : styled === 'left' || styled === 'right' ? styled : 'center';
      const positions = node.children.filter(c => c.name === 'param' && c.attrs.name === 'Position').map(c => pair(c.attrs.value));
      const x = align === 'left' && positions.length ? clamp(.03, .6, .5 + Math.min(...positions.map(p => p[0])) / ctx.width) : .05, width = align === 'left' ? Math.min(.94, .97 - x) : .9;
      // Final Cut breaks lines only where the text does (Auto-Shrink fits them to the margins); SharedCut would wrap
      // at its box instead, so a line wider than the box shrinks the whole title, as Auto-Shrink does.
      const widths = [0];
      if (measure) for (const r of runs) for (const [k, part] of r.text.split('\n').entries()) { if (k) widths.push(0); widths[widths.length - 1] += part ? measure(part, r.style) : 0; }
      const fit = Math.min(1, .98 * width * ctx.width / Math.max(1, ...widths));
      if (fit < 1) for (const r of runs) r.style = { ...r.style, fontSize: Math.max(4, round(r.style.fontSize * fit)), letterSpacing: round(r.style.letterSpacing * fit) };
      const lineHeight = tight ? 1 : 1.14, lines: number[] = [0];
      for (const r of runs) for (const [k, part] of r.text.split('\n').entries()) { if (k) lines.push(0); if (part) lines[lines.length - 1] = Math.max(lines[lines.length - 1], r.style.fontSize); }
      const height = clamp(.01, 1, lines.reduce((sum, size) => sum + (size || runs[0].style.fontSize) * lineHeight, 0) / ctx.height);
      const bottoms = node.children.filter(c => c.name === 'param' && c.attrs.name === 'Bottom Margin').map((c, i) => (positions[i]?.[1] ?? 0) + Number(c.attrs.value));
      const y = /Bottom/.test(placement) && bottoms.length ? .5 - Math.min(...bottoms) / ctx.height - height : .5 - (positions[0]?.[1] ?? 0) / ctx.height - height / 2;
      const doc: TextDocument = { ...defaultTextEffects, runs: runs.slice(0, 1000), x, y: clamp(-4, 4, y), width, height, align, lineHeight, opacity: 100 };
      const look = picture(ctx, node, own, span, label);
      out.push(place(ctx, 'video', lane, { mediaId: 'frameline-title', name: content.replace(/\s+/g, ' ').trim().slice(0, 80), start: span.lo, duration: span.hi - span.lo, sourceIn: 0, color: '#8e75ba',
        disabled: node.attrs.enabled === '0', properties: { animationPresetDuration: span.hi - span.lo, textDocument: JSON.stringify(doc), ...look.properties }, keyframes: look.keyframes }, look));
    }
    connected(ctx, node, own, win, lane);
    markers(ctx, node, own, span);
    return out;
  }

  /**
   * A storyline transition. Picture: the incoming clip's transition, aligned where Final Cut put it on the cut, or a
   * fade where one side is a gap. Sound: SharedCut has no audio transition, so both sounds reach into their handles to
   * overlap across Final Cut's window and fade there; the overlap lands on a second audio track.
   */
  function transition(ctx: Ctx, node: XmlNode, parent: Frame, outgoing: Placed[], incoming: Placed[]) {
    const begin = at(parent, fcpTime(node.attrs.offset)), length = Math.min(30, fcpTime(node.attrs.duration) * parent.rate);
    if (!(length > 0)) return;
    const filter = child(node, 'filter-video'), label = filter?.attrs.name ?? resources.get(filter?.attrs.ref ?? '')?.attrs.name ?? node.attrs.name ?? 'Cross Dissolve';
    let name = TRANSITIONS[label] ?? 'Cross dissolve';
    if (name === 'Dip to black' && hex(param(filter, 'Color')?.attrs.value, '#000000') === '#ffffff') name = 'Dip to white';
    if (!transitionDefinitions[name]) name = 'Cross dissolve';
    if (!EXACT_TRANSITIONS.has(label)) gap(`Transition "${label}" imports as SharedCut's "${name}"`);
    const vOut = outgoing.find(p => p.kind === 'video')?.clip, vIn = incoming.find(p => p.kind === 'video')?.clip;
    if (vOut && vIn && Math.abs(vOut.start + vOut.duration - vIn.start) < 1e-6) {
      const share = (vIn.start - begin) / length;
      vIn.transition = name;
      Object.assign(vIn.properties, { transitionDuration: round(length), transitionAlign: share < .25 ? 'in' : share > .75 ? 'out' : 'center', transitionParams: '{}' });
    } else if (vIn) vIn.properties.fadeIn = round(Math.min(vIn.duration, Math.max(0, begin + length - vIn.start)));
    else if (vOut) vOut.properties.fadeOut = round(Math.min(vOut.duration, Math.max(0, vOut.start + vOut.duration - begin)));
    // A switched-off sound has nothing to fade: the other one fades against silence.
    const aOut = outgoing.find(p => p.kind === 'audio' && !p.clip.disabled)?.clip, aIn = incoming.find(p => p.kind === 'audio' && !p.clip.disabled)?.clip;
    const plain = (c: Clip) => !c.properties.reverse && !c.properties.freeze && !c.keyframes?.['properties.speed'];
    if (aOut && aIn && plain(aOut) && plain(aIn)) {
      const cut = aIn.start, rateIn = Number(aIn.properties.speed ?? 100) / 100, rateOut = Number(aOut.properties.speed ?? 100) / 100;
      const sourceLength = mediaById.get(aOut.mediaId)?.duration ?? 0;
      // Whole frames only, never past the media's first or last frame.
      const floor = (t: number) => Math.max(0, Math.floor(t * ctx.fps + 1e-6) / ctx.fps);
      const head = floor(Math.min(cut - begin, aIn.sourceIn / rateIn)), tail = floor(Math.min(begin + length - cut, (sourceLength - aOut.sourceIn) / rateOut - aOut.duration));
      if (head > 0) {
        aIn.start = round(aIn.start - head); aIn.duration = round(aIn.duration + head); aIn.sourceIn = Math.max(0, round(aIn.sourceIn - head * rateIn));
        for (const keys of Object.values(aIn.keyframes ?? {})) for (const k of keys) k.time = round(k.time + head);
      }
      aOut.duration = round(aOut.duration + tail);
      aIn.properties.audioFadeIn = round(Math.min(aIn.duration, head + Math.max(0, begin + length - cut)));
      aOut.properties.audioFadeOut = round(Math.min(aOut.duration, tail + Math.max(0, cut - begin)));
    } else if (aIn) aIn.properties.audioFadeIn = round(Math.min(aIn.duration, Math.max(0, begin + length - aIn.start)));
    else if (aOut) aOut.properties.audioFadeOut = round(Math.min(aOut.duration, Math.max(0, aOut.start + aOut.duration - begin)));
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
  if (media.size > 5000) throw new Error('Import at most 5,000 source files per project.');
  if (clips.length > 20_000) throw new Error('Import at most 20,000 timeline items.');

  const warnings = [...gaps].map(([what, count]) => count > 1 ? `${what} (×${count})` : what).sort();
  const project: Project = { id: projectId, name: (projects[0].attrs.name || 'Final Cut project').slice(0, 255), description: 'Imported from Final Cut Pro.', shared: false, thumbnail: '', modifiedAt: Date.now(),
    duration: main.duration, resolution: `${projectWidth} × ${projectHeight}`, fps: projectFps, status: 'In progress', members: [{ userId, role: 'Owner' }] };
  Object.assign(project, { fcpImportHash: createHash('sha256').update(xml).digest('hex'), fcpWarnings: warnings.slice(0, 500) });
  return { project, media: [...media.values()], timelines, tracks, clips, nodes, warnings };
}
