// What the model can do and the reference it reads on demand. The action list is parsed from the EditorStore
// interface in src/state/store.ts at runtime, and the catalogs come from the app's own definitions, so a new effect,
// transition or title preset shows up here with no MCP change. A new store ACTION must be classified in ACTIONS:
// mcp/coverage.test.ts fails until it is.
import { appFile } from './env.ts';
import { fileURLToPath } from 'node:url';
import { effectDefinitions } from '../src/services/effects.ts';
import { transitionDefinitions } from '../src/services/transitions.ts';
import { titlePresets } from '../src/services/text.ts';
import { shapeKinds, defaultShape } from '../src/services/shapes.ts';
import { blendModeNames } from '../src/services/blendModes.ts';
import { defaultProperties } from '../src/state/demo.ts';
import { JOBS, JOB_TOPICS } from './jobs.ts';

/**
 * Every EditorStore method, and how the MCP exposes it:
 *  edit     changes the project (act; a refused edit rolls the whole batch back)
 *  context  sets what later steps act on, only reads, or saves outside the project (selection, playhead, clipboard,
 *           plans, shared presets); never "refused" for changing nothing
 *  job:x    needs a local file or server work; use job{kind:"x"}
 *  hidden   UI plumbing (toasts, locks, playback clock, panels); not offered
 */
export const ACTIONS: Record<string, 'edit' | 'context' | 'hidden' | `job:${string}`> = {
  selectTransition: 'context', saveTransitionPreset: 'context', toggleTransitionFavorite: 'context', loadLeaks: 'context', addLeak: 'job:overlay',
  addShape: 'edit', addAdjustment: 'edit', updateShape: 'edit', editShapePoint: 'edit',
  selectClips: 'context', createComposition: 'edit', openComposition: 'context', leaveComposition: 'context',
  setAnimationChannels: 'edit', selectForward: 'context', cutThrough: 'edit',
  installCaptions: 'job:captions', regroupCaptions: 'edit', styleCaptions: 'edit', updateCaption: 'edit',
  addTitle: 'edit', selectText: 'context', updateText: 'edit', formatText: 'edit',
  openProject: 'context', createProject: 'edit', setTimelineFormat: 'edit',
  setWorkspace: 'context', selectClip: 'context', selectNode: 'context',
  setPlayhead: 'context', setRange: 'context', setPlaying: 'hidden', setSidePanel: 'hidden', setModal: 'hidden',
  updateProperty: 'edit', setKeyframes: 'edit', keyframeProperty: 'edit', unlinkClip: 'edit', linkClip: 'edit',
  moveClip: 'edit', trimClip: 'edit', fitTrim: 'context', planTrimEdit: 'context', trimEdit: 'edit',
  setMarkers: 'edit', addMarker: 'edit', deleteMarkers: 'edit', copyMarkers: 'context', pasteMarkers: 'edit',
  deleteGaps: 'edit', deleteGap: 'edit', splitClip: 'edit', deleteClip: 'edit', duplicateClip: 'edit', copyClip: 'context', pasteClip: 'edit',
  addMediaToTimeline: 'edit', updateTrack: 'edit', moveTrack: 'edit', deleteTrack: 'edit', createTrack: 'edit', setTimeline: 'context',
  addTransition: 'edit', updateTransition: 'edit', removeTransition: 'edit', expandTransitionAudio: 'edit', applyTransitionAtPlayhead: 'edit',
  addSmartMask: 'edit', updateSmartMask: 'edit', attachSmartMask: 'edit',
  addMotionTracker: 'edit', updateMotionTracker: 'edit', deleteMotionTracker: 'edit', applyMotionTracker: 'edit',
  addEffect: 'edit', updateEffect: 'edit', reorderEffect: 'edit', addNode: 'edit', removeNode: 'edit', reorderNode: 'edit',
  copyGrade: 'context', pasteGrade: 'edit', applyColorAssistant: 'edit', useAcesOutput: 'edit',
  normalizeColorGroup: 'edit', setColorGroup: 'edit', updateColorGroup: 'edit', renameColorGroup: 'edit',
  restoreResolveGrade: 'edit', initializeColorGrade: 'edit', arrangeColorNodes: 'edit', moveColorNode: 'edit', updateNode: 'edit',
  // applyGrade is the old rule-based path with no UI caller: it appends nodes after the Output CST.
  applyGrade: 'hidden',
  undo: 'edit', redo: 'edit', saveSnapshot: 'edit', restoreSnapshot: 'edit',
  addComment: 'edit', replyComment: 'edit', resolveComment: 'edit',
  enqueueRender: 'job:export', updateRender: 'job:exports',
  uploadMedia: 'job:upload', renameMedia: 'edit', removeMedia: 'edit', retryMedia: 'edit', revealMedia: 'hidden', replaceMedia: 'job:replace',
  createBin: 'edit', renameBin: 'edit', deleteBin: 'edit', moveMedia: 'edit',
  setUserColor: 'edit', setUserProfile: 'edit', setCurrentUser: 'hidden',
  setSettings: 'edit', notify: 'hidden', dismissNotification: 'hidden',
  acquireLock: 'hidden', renewLock: 'hidden', releaseLock: 'hidden', releaseUserLocks: 'hidden', acquireLocks: 'hidden', releaseLocks: 'hidden',
  tick: 'hidden', setLiveMode: 'hidden',
};

export interface StoreMember { name: string; signature: string; doc: string; method: boolean }

/** The members of `export interface EditorStore` with their signatures and doc comments, in source order. */
export function storeMembers(source = appFile('src/state/store.ts')): StoreMember[] {
  const start = source.indexOf('export interface EditorStore');
  const open = source.indexOf('{', start), end = source.indexOf('\n}', open);
  const body = source.slice(open + 1, end), members: StoreMember[] = [];
  let depth = 0, current = '', doc = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (depth === 0 && body.startsWith('/**', i)) { const close = body.indexOf('*/', i); doc = body.slice(i + 3, close).replace(/\s*\*\s?/g, ' ').trim(); i = close + 1; continue; }
    if (depth === 0 && body.startsWith('//', i)) { const next = body.indexOf('\n', i); if (next < 0) break; i = next - 1; continue; }
    if ('({[<'.includes(c)) depth++;
    if (')}]'.includes(c) || (c === '>' && body[i - 1] !== '=')) depth--;
    if ((c === ';' || c === '\n') && depth === 0) {
      const text = current.trim().replace(/\s+/g, ' ');
      if (text) {
        // `a: x; b: y` declares fields; `name(args): ret` declares a method.
        const method = /^(\w+)\s*\(/.exec(text);
        if (method) members.push({ name: method[1], signature: text, doc, method: true });
        else for (const field of text.split(/,\s*(?=\w+\??:)/)) { const name = /^(\w+)\??:/.exec(field.trim()); if (name) members.push({ name: name[1], signature: field.trim(), doc, method: false }); }
        doc = '';
      }
      current = '';
      continue;
    }
    current += c;
  }
  return members;
}

let nullable: Map<string, boolean[]> | undefined;
/** Per parameter of a store action: whether its declared type takes null (updateEffect's null removes the effect). */
export function nullableParams(name: string): boolean[] {
  nullable ??= new Map(storeMembers().filter(m => m.method).map(m => {
    const inside = m.signature.slice(m.signature.indexOf('(') + 1), params: string[] = [];
    let depth = 0, part = '';
    for (const c of inside) {
      if (depth === 0 && c === ')') break;
      if ('({[<'.includes(c)) depth++;
      if (')}]>'.includes(c)) depth--;
      if (c === ',' && depth === 0) { params.push(part); part = ''; } else part += c;
    }
    params.push(part);
    return [m.name, params.map(p => /\bnull\b/.test(p))];
  }));
  return nullable.get(name) ?? [];
}

const short = (signature: string) => signature.replace(/:\s*void$/, '').replace(/import\('[^']+'\)\./g, '').replace(/\s*:\s*/g, ':').replace(/,\s*/g, ', ');
const range = (p: { min?: number; max?: number; initial: number | string; suffix?: string; choices?: readonly string[] }) =>
  p.choices ? `${p.initial} [${p.choices.join('|')}]` : `${p.initial} (${p.min ?? ''}–${p.max ?? ''}${p.suffix?.trim() ?? ''})`;

const CATALOGS: Record<string, () => string> = {
  actions: () => {
    const lines = storeMembers().filter(m => m.method && ACTIONS[m.name] && ACTIONS[m.name] !== 'hidden').map(m => {
      const kind = ACTIONS[m.name];
      return `${short(m.signature)}${kind.startsWith('job:') ? ` [use job ${kind.slice(4)}]` : kind === 'context' ? ' [context]' : ''}${m.doc ? ` — ${m.doc}` : ''}`;
    });
    return `Run with act{do:[[name, ...args]]}. Args are positional like the signatures; ids as @handles. Actions read the open project/timeline, selection and playhead (set them with act{select, at, timeline} or the [context] actions).\n${lines.join('\n')}`;
  },
  effects: () => `Clip effects: act addEffect(clipId, name) then updateEffect(clipId, effectId, {amount, enabled, parameters:{key:value}}). Values: key=default (min–max).\n` +
    Object.entries(effectDefinitions).map(([name, d]) => `${name} [${d.kind}] ${d.description} · ${d.parameters.map(p => `${p.key}=${range(p)}`).join(', ')}`).join('\n'),
  transitions: () => `act addTransition(clipId, "in"|"out", name, {duration, align:"center"|"in"|"out", params}) · updateTransition · removeTransition. Default "Cross dissolve". A dissolve goes on the incoming clip's "in" side. Neither clip of a transition may be keyframed (export refuses).\n` +
    Object.entries(transitionDefinitions).map(([name, d]) => `${name} [${d.kind}${d.overlay ? ', overlay' : ''}]${d.defaultDuration ? ` ${d.defaultDuration}s` : ''} ${d.description}${d.parameters.length ? ' · ' + d.parameters.map(p => `${p.key}=${range(p)}`).join(', ') : ''}`).join('\n'),
  titles: () => `act addTitle(presetIndex, box?, placement?:{start, trackId}, animated?) adds a title at the playhead. Change its words, style or box with job text{clip, text?, style?, box?} (help text); it keeps the animation. A box given to addTitle makes the title static: place it with placement, then move it with job text{box}.\n` +
    titlePresets.map((p, i) => `${i} ${p.name} (${p.category}): ${JSON.stringify(p.text.split('\n')[0])}`).join('\n'),
  shapes: () => `act addShape(kind, box?:{x,y,width,height} as 0-1 of the frame, placement?) · updateShape(clipId, doc) with the full doc from get{path:"properties.shapeDocument"}.\npen: addShape("pen", {points:[{x,y},…], closed?}) with no x/y/width/height takes points as 0-1 of the frame and fits the box; inside a doc, points (and optional bezier handles inX,inY,outX,outY) are 0-1 of the shape's box.\nkinds: ${shapeKinds.join(', ')}\ndoc fields (defaults): ${JSON.stringify(defaultShape())}`,
  properties: () => `Clip properties: act updateProperty(clipId, key, value). Defaults: ${JSON.stringify(defaultProperties)}\nblendMode: ${blendModeNames.join(', ')}\n${JOB_TOPICS.properties ?? ''}`,
  jobs: () => `job{kind, params, wait}. Long work returns an id: poll job{kind:"status", id}; stop with job{kind:"cancel", params:{id}}.\n` + Object.entries(JOBS).map(([kind, j]) => `${kind}: ${j.doc}`).join('\n'),
};

export const topicNames = () => [...new Set([...Object.keys(CATALOGS), ...Object.keys(JOB_TOPICS)])];
export function help(topic?: string, filter?: string) {
  const names = topicNames();
  if (!topic) return `topics: ${names.join(', ')}. help{topic, filter} narrows to matching lines.`;
  let key = topic.toLowerCase();
  if (!names.includes(key) && names.includes(`${key}s`)) key = `${key}s`;
  const text = CATALOGS[key]?.() ?? JOB_TOPICS[key];
  if (!text) return `No topic "${topic}". topics: ${names.join(', ')}`;
  if (!filter) return text;
  const want = filter.toLowerCase(), [head, ...lines] = text.split('\n');
  const hits = lines.filter(line => line.toLowerCase().includes(want));
  return `${head}\n${hits.join('\n') || `(nothing matches "${filter}")`}`;
}
