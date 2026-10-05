// Running editor actions for the model: catch up with the server, run store actions with the app's own refusal
// messages caught, save once, and report what changed. A refused step or a refused save rolls the whole batch back.
import { AsyncLocalStorage } from 'node:async_hooks';
import { useEditorStore as store, persistentState } from '../src/state/store.ts';
import { connect, refresh, flush, settle, revert, signedIn, inFlight, holdBackgroundSaves } from './session.ts';
import { changeSummary, resolveHandles, handle, isLongId } from './views.ts';
import { ACTIONS, nullableParams } from './catalog.ts';
import { timelineTransitions } from '../src/services/transitions.ts';
import { isAnimated } from '../src/services/animation.ts';
import type { PersistedState } from '../src/services/index.ts';

let switched = '';
/** A note for the model when ready() moved it to another project (its project went away); read once. */
export function takeSwitchNote() { const note = switched; switched = ''; return note; }

/** Signed in, caught up, and a project open (the one touched last, until the model opens another). */
export async function ready() {
  if (!signedIn()) await connect(); else await refresh();
  const s = store.getState();
  if (!s.projectId || !s.projects.some(p => p.id === s.projectId)) {
    const recent = [...s.projects].sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
    if (recent) { if (s.projectId) switched = `(The open project is gone; now in "${recent.name}" ${handle(recent.id)}.)`; s.openProject(recent.id); }
  } else if (!s.timelines.some(t => t.id === s.timelineId)) s.openProject(s.projectId); // its timeline was deleted elsewhere
  return store.getState();
}
export function findProject(text: string) {
  const s = store.getState(), want = text.toLowerCase();
  const id = text.startsWith('@') ? resolveHandles(text, s) : text;
  const project = s.projects.find(p => p.id === id) ?? s.projects.find(p => p.name.toLowerCase() === want) ?? s.projects.filter(p => p.name.toLowerCase().includes(want)).sort((a, b) => b.modifiedAt - a.modifiedAt)[0];
  if (!project) throw new Error(`No project matches "${text}".`);
  return project;
}
export function findTimeline(text: string) {
  const s = store.getState(), want = text.toLowerCase(), id = text.startsWith('@') ? resolveHandles(text, s) : text;
  const timeline = s.timelines.find(t => t.id === id) ?? s.timelines.find(t => t.projectId === s.projectId && t.name.toLowerCase() === want);
  if (!timeline) throw new Error(`No timeline matches "${text}".`);
  return timeline;
}
/** Make `text` the open timeline, opening its project first (setTimeline ignores another project's timeline). */
export function openTimeline(text: string) {
  const timeline = findTimeline(text);
  if (timeline.projectId !== store.getState().projectId) store.getState().openProject(timeline.projectId);
  store.getState().setTimeline(timeline.id);
  if (store.getState().timelineId !== timeline.id) throw new Error(`Could not open timeline ${handle(timeline.id)}.`);
  return timeline;
}
const MAX_LINES = 220;
export const cap = (text: string, hint: string) => { const lines = text.split('\n'); return lines.length <= MAX_LINES ? text : `${lines.slice(0, MAX_LINES).join('\n')}\n… ${lines.length - MAX_LINES} more lines; ${hint}`; };
/** A value for the model to read, with every id shortened to its handle. */
export const shown = (value: unknown): string => typeof value === 'string' ? (isLongId(value) && !/\s/.test(value) ? handle(value) : value)
  : JSON.stringify(value, (_k, v) => typeof v === 'string' && isLongId(v) && !/\s/.test(v) ? handle(v) : v);

// Which batch code is running: the batch body itself (step undefined) or one of its steps. Work a step starts keeps
// its batch and step, so a retry loop it leaves behind (even from an earlier batch) is told apart from the code running now.
const scope = new AsyncLocalStorage<{ batch: symbol; step?: number }>();
const persisted = (state = store.getState()) => persistentState(state);
/** Export refuses a transition whose clips are keyframed (server/media.ts renders the window whole): the same rule, in its words. */
function keyframedTransitions(state: PersistedState) {
  const out = new Set<string>();
  for (const timeline of state.timelines) {
    const clips = state.clips.filter(c => c.timelineId === timeline.id);
    if (!clips.some(c => c.transition || c.properties.transitionOut)) continue;
    for (const record of timelineTransitions(clips, timeline.id, state.media)) {
      const animated = clips.find(c => (c.id === record.outgoingId || c.id === record.incomingId) && c.start < record.end - 1e-6 && c.start + c.duration > record.start + 1e-6 && isAnimated(c));
      if (animated) out.add(`${animated.name} ${handle(animated.id)}: a transition cannot sit on a keyframed clip; Export and frame refuse it. Remove its keyframes or the ${record.name} transition.`);
    }
  }
  return out;
}
// A store commit that clamps to nothing still writes a history row; the project itself did not change.
const projectOnly = (state = store.getState()) => JSON.stringify({ ...persisted(state), operations: undefined });

/** Runs one store action by name; @handles in its arguments are resolved first. */
export type Runner = (name: string, ...args: unknown[]) => Promise<unknown>;

/** One saved batch. `body` runs store actions through `run`; a refusal throws and nothing is saved. `checked` (the
 *  model's own act steps) also refuses UI plumbing and actions that need a file or server work. */
export async function edit<T>(body: (run: Runner) => Promise<T>, checked = false): Promise<{ text: string; value: T }> {
  let s = await ready();
  const before = persisted(s), notes: string[] = [], batch = Symbol('batch');
  const caught: { title: string; kind: string; detail?: string }[] = [];
  const notify = s.notify;
  store.setState({ notify: (title, kind = 'info', detail) => { caught.push({ title, kind, detail }); notify(title, kind, detail); } });
  let steps = 0, current = 0;
  const run: Runner = (name, ...raw) => scope.run({ batch, step: steps + 1 }, async () => {
    const step = ++steps, info = ACTIONS[name];
    if (!info) throw new Error(`Step ${step}: no action "${name}". help{topic:"actions"} lists them.`);
    if (checked && info.startsWith('job:')) throw new Error(`Step ${step}: ${name} needs a file or server work; use job{kind:"${info.slice(4)}"} instead.`);
    if (checked && info === 'hidden') throw new Error(`Step ${step}: ${name} is part of the editor's UI plumbing and not available here.`);
    s = store.getState();
    // JSON has no undefined: a null standing in for a skipped optional argument becomes one, unless null means something there.
    const nullable = nullableParams(name), args = resolveHandles(raw, s).map((arg, i) => arg === null && !nullable[i] ? undefined : arg);
    const mark = caught.length, was = projectOnly(s), earlier = inFlight();
    let value: unknown;
    current = step;
    // Two actions throw instead of notifying (addTitle on a bad box, a broken composition paste).
    try { value = (s as unknown as Record<string, (...a: unknown[]) => unknown>)[name](...args); if (value instanceof Promise) value = await value; await settle(earlier); }
    catch (error) { throw new Error(`Step ${step} (${name}) failed: ${String(error instanceof Error ? error.message : error).replace(/\.?$/, '.')}`); }
    finally { current = 0; }
    const fresh = caught.slice(mark), changed = projectOnly() !== was;
    const error = fresh.find(n => n.kind === 'error');
    // Store actions refuse by notifying and changing nothing ("Unlock the track to edit this clip").
    if (error || (!changed && fresh.length && info === 'edit')) {
      const reason = error ?? fresh[0];
      throw new Error(`Step ${step} (${name}) was refused: ${`${reason.title}${reason.detail ? ` — ${reason.detail}` : ''}`.replace(/\.?$/, '.')}`);
    }
    // Many refusals are silent (an unknown id, an identical value, a trim clamped to nothing): say so rather than report success.
    if (!changed && !fresh.length && info === 'edit') notes.push(`step ${step} (${name}) changed nothing: check its ids and arguments (it may be clamped by the media or a neighbour)`);
    for (const n of fresh) notes.push(n.title + (n.detail ? ` — ${n.detail}` : ''));
    return value;
  });
  let value: T, finished!: () => void, ours = new Set<string>();
  const owns = () => { const at = scope.getStore(); return at?.batch === batch && (at.step === undefined || at.step === current); };
  holdBackgroundSaves({ owns, done: new Promise<void>(resolve => { finished = resolve; }) });
  try {
    value = await scope.run({ batch }, () => body(run));
    const had = new Set(before.operations.map(op => op.id)), sent = persisted(), warned = keyframedTransitions(before);
    ours = new Set(sent.operations.filter(op => !had.has(op.id)).map(op => op.id));
    for (const warning of keyframedTransitions(sent)) if (!warned.has(warning)) notes.push(warning);
    await flush();
  } catch (error) {
    revert();
    // Some steps save on their own (a preset, a media delete, a profile change) before a later one is refused: say what stays.
    const kept = changeSummary(before, persisted(), store.getState());
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(kept.length ? `${message} Already saved by earlier steps, and kept:\n${kept.join('\n')}` : /saved|unknown/i.test(message) ? message : `${message} Nothing was saved.`);
  } finally {
    holdBackgroundSaves(null); finished();
    store.setState({ notify });
  }
  s = store.getState();
  const lines = changeSummary(before, persisted(s), s, ours);
  return { value, text: [lines.length ? lines.join('\n') : 'Saved; nothing in the project changed.', ...(notes.length ? [`notes: ${[...new Set(notes)].join(' | ')}`] : [])].join('\n') };
}

/** The act tool: context first (timeline, selection, playhead), then each [action, ...args] in order. */
export async function act(args: { do: unknown[]; at?: number; select?: string[]; timeline?: string }) {
  if (!Array.isArray(args.do) || !args.do.length) throw new Error('Give do: [["actionName", ...args], ...]. help{topic:"actions"} lists them.');
  const results: string[] = [];
  const { text } = await edit(async run => {
    if (args.timeline) openTimeline(args.timeline);
    // A selection left from an earlier call would silently widen moves and deletes to the whole group.
    store.getState().selectClips(resolveHandles(args.select ?? [], store.getState()));
    if (args.at !== undefined) store.getState().setPlayhead(args.at);
    for (const step of args.do) {
      const [name, ...rest] = Array.isArray(step) ? step : [step];
      const value = await run(String(name), ...rest);
      if (value !== undefined) results.push(`${name} → ${shown(value)}`);
    }
  }, true);
  return [text, ...results].join('\n');
}
