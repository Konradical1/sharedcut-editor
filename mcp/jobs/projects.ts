// Projects: the changes that bypass the store and go straight to an endpoint, the way Dashboard.tsx and
// Collaboration.tsx do them (save first, call, catch up): owner fields and sharing, one person's role, delete and
// restore. Plus a read-only listing of history, snapshots and comments so the model has their ids, and the help
// topics for keyframes, ids, history, settings and clip properties. Create, format, profile and settings are act.
import { appFile } from '../env.ts';
import { fileURLToPath } from 'node:url';
import { call, refresh, store, handle, done, need, project, type JobDef } from './kit.ts';
import { flush } from '../session.ts';
import { findProject } from '../edit.ts';
import { clock } from '../views.ts';
import { animationProperties, boundedAnimationValue } from '../../src/services/animation.ts';
import { loudnessTargets } from '../../src/services/effects.ts';
import { transitionNames } from '../../src/services/transitions.ts';
import { defaultProperties } from '../../src/state/demo.ts';
import type { Clip, Project, ProjectMember } from '../../src/state/models.ts';
import { projectActivityLabel } from '../../src/services/library.ts';
import type { LibraryView } from '../../src/services/library.ts';

const ROLES = ['Editor', 'Commenter', 'Viewer'] as const;
const FIELDS = ['project', 'name', 'description', 'status', 'access', 'members', 'classRole'];
const quote = (text: string, max = 60) => JSON.stringify(text.length > max ? text.slice(0, max - 1) + '…' : text);
const ago = (ms: number) => { const m = Math.round((Date.now() - ms) / 60_000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const target = (params: Record<string, any>) => params.project ? findProject(String(params.project)) : project();
const fresh = (id: string) => store.getState().projects.find(p => p.id === id);
const path = (id: string) => `/projects/${encodeURIComponent(id)}`;

/** A person by id (the job tool already turned @handles into ids), name or email. */
function person(text: string) {
  const want = text.toLowerCase(), hits = store.getState().users.filter(u => u.id === text || u.name.toLowerCase() === want || (!!u.email && u.email.toLowerCase() === want));
  if (hits.length === 1) return hits[0];
  throw new Error(hits.length ? `"${text}" matches ${hits.length} people; use their @handle (job project{} lists them).` : `No one called "${text}". job project{} lists people.`);
}
function role(value: unknown, none = false) {
  if ((ROLES as readonly unknown[]).includes(value) || (none && value === 'none')) return value as ProjectMember['role'] | 'none';
  throw new Error(`role must be ${ROLES.join(', ')}${none ? ' or "none"' : ''} (got ${JSON.stringify(value)}).`);
}

const access = (p: Project) => p.shared ? `class (everyone ${p.classRole ?? 'Editor'})` : p.members.length > 1 ? 'people' : 'private';
/** The project as the model needs it after a change; `full` adds the description and who could be added. */
function describe(p: Project, full = false) {
  const s = store.getState(), name = (id: string) => s.users.find(u => u.id === id)?.name ?? '?';
  // On a class project everyone is a member; only the owner and per-person overrides are worth a line.
  const shown = p.members.filter(m => !p.shared || m.role === 'Owner' || m.role !== (p.classRole ?? 'Editor'));
  const lines = [
    `${handle(p.id)} ${quote(p.name)} · ${p.status} · ${p.resolution.replace(/ /g, '')} ${p.fps}fps · access ${access(p)}`,
    `members: ${shown.map(m => `${name(m.userId)} ${handle(m.userId)} ${m.role}`).join(', ')}`,
  ];
  if (p.lock) lines.push(`locked${p.lock.note ? ` (${quote(p.lock.note)})` : ''} by ${name(p.lock.userId)}: read-only for everyone until unlocked (lock-project{unlock:true})`);
  if (full) {
    if (p.description) lines.push(`description: ${quote(p.description, 200)}`);
    const others = s.users.filter(u => !p.members.some(m => m.userId === u.id));
    if (others.length) lines.push(`others: ${others.slice(0, 30).map(u => `${u.name} ${handle(u.id)}`).join(', ')}${others.length > 30 ? ` …${others.length - 30} more` : ''}`);
  }
  return lines.join('\n');
}

/** Save pending edits, call the endpoint, catch up: the order the UI uses, so the next save does not 409. */
async function direct<T>(route: string, init: RequestInit & { json?: unknown }) {
  await flush();
  const result = await call<T>(route, init);
  await refresh();
  return result;
}

export const jobs: Record<string, JobDef> = {
  'project-activity': {
    doc: '{project?} latest person who edited or viewed each accessible project in the past 24 hours; optional project name/id',
    async start(params) {
      const library = await call<LibraryView>('/library'), s = store.getState();
      const selected = params.project ? [target(params)] : s.projects;
      const rows = selected.flatMap(p => {
        const activity = library.activity?.[p.id], label = projectActivityLabel(activity, s.users);
        return label ? [`${handle(p.id)} ${quote(p.name)} · ${label}`] : [];
      });
      return done(rows.join('\n') || 'No activity in the past 24 hours.');
    },
  },
  project: {
    doc: '{project?, name?, description?, status?:In progress|In review|Complete, access?:private|people|class, members?:[[user,role]] (replaces), classRole?:Editor|Viewer} owner only; no fields = show it + people',
    async start(params) {
      const unknown = Object.keys(params).filter(k => !FIELDS.includes(k));
      if (unknown.length) throw new Error(`Unknown ${unknown.join(', ')}. Format: act setTimelineFormat(w,h,fps). Allowed: ${FIELDS.join(', ')}.`);
      const p = target(params), body: Record<string, unknown> = {};
      for (const key of ['name', 'description', 'status', 'access', 'classRole']) if (params[key] !== undefined) body[key] = params[key];
      if (params.members !== undefined) {
        body.members = need<unknown[]>(params, 'members', 'array').map(m => {
          const [who, as] = Array.isArray(m) ? m : [(m as any)?.user ?? (m as any)?.userId, (m as any)?.role];
          return { userId: person(String(who)).id, role: role(as) };
        });
        // Without access the server keeps the current one, and "private" would drop the list just sent.
        body.access ??= p.shared ? 'class' : (body.members as unknown[]).length ? 'people' : 'private';
      }
      if (!Object.keys(body).length) return done(describe(p, true));
      await direct(path(p.id), { method: 'PATCH', json: body });
      return done(describe(fresh(p.id) ?? p));
    },
  },
  member: {
    doc: '{project?, user, role:"Editor"|"Commenter"|"Viewer"|"none"} one person\'s role, keeping the others; none removes (class: back to the class role)',
    async start(params) {
      const p = target(params), who = person(need(params, 'user')), as = role(params.role, true);
      if (p.members.some(m => m.userId === who.id && m.role === 'Owner')) throw new Error("The owner's role cannot change.");
      if (p.shared && as !== 'none') {
        // Collaboration.tsx's route: it also releases their locks when they stop being an Editor.
        await direct(`${path(p.id)}/members/${encodeURIComponent(who.id)}`, { method: 'PATCH', json: { role: as } });
      } else {
        // The store's members are effective roles (folders, the whole class); the library has the project's own list.
        const library = await call<LibraryView>('/library');
        const others = (library.directMembers[p.id] ?? p.members).filter(m => m.role !== 'Owner' && m.userId !== who.id);
        const members = as === 'none' ? others : [...others, { userId: who.id, role: as }];
        await direct(path(p.id), { method: 'PATCH', json: { access: p.shared ? 'class' : members.length ? 'people' : 'private', members } });
      }
      return done(describe(fresh(p.id) ?? p));
    },
  },
  'delete-project': {
    doc: '{project, confirm:true} deletes it for everyone; only you can restore it for 7 days (restore-project)',
    async start(params) {
      // Not findProject: its substring fallback could pick the wrong project for a delete.
      const text = need(params, 'project'), want = text.toLowerCase(), hits = store.getState().projects.filter(x => x.id === text || x.name.toLowerCase() === want);
      if (hits.length !== 1) throw new Error(hits.length ? `${hits.length} projects are called "${text}"; use the @handle from projects.` : `No project is exactly "${text}"; use its @handle from projects.`);
      const p = hits[0];
      if (params.confirm !== true) throw new Error(`Deleting ${handle(p.id)} ${quote(p.name)} removes it for every member. Repeat with confirm:true if the user asked for it.`);
      const backup = await direct<{ projectId: string; expiresAt: number }>(path(p.id), { method: 'DELETE' });
      return done(`deleted ${quote(p.name)} · restorable until ${day(backup.expiresAt)}: job restore-project{id:"${handle(p.id).slice(1)}"}`);
    },
  },
  'lock-project': {
    doc: '{project?, unlock?:true, note?} owner only: read-only for everyone, you included, until unlocked (e.g. while it is edited offline)',
    async start(params) {
      const p = target(params);
      await direct(`${path(p.id)}/lock`, params.unlock === true ? { method: 'DELETE' } : { method: 'PUT', json: { note: String(params.note ?? '') } });
      return done(describe(fresh(p.id) ?? p));
    },
  },
  'keep-offline': {
    doc: '{project?, stop?:true} SharedCut Desktop only: keep a sharedcut.com project (name or id) on this computer, live online, merged after offline edits; ones made here go up by themselves; no project = what is kept',
    async start(params) {
      type Kept = { id: string; name: string; kept: boolean; status?: string; error?: string; uploading: number; downloading: number };
      const link = await call<{ user: { email: string } | null; expired?: string | null; online: boolean; projects: Kept[] }>('/remote').catch(() => { throw new Error('Only SharedCut Desktop syncs with sharedcut.com; this server does not.'); });
      if (!link.user) throw new Error(link.expired ? `The sharedcut.com session of ${link.expired} ended: sign in again on the Projects screen of SharedCut Desktop.` : 'Not signed in to sharedcut.com: sign in on the Projects screen of SharedCut Desktop.');
      const line = (p: Kept) => `${handle(p.id)} ${quote(p.name)} ${p.kept ? p.error ?? p.status ?? 'syncing' : 'only online'}${p.uploading ? ` · ${p.uploading} up` : ''}${p.downloading ? ` · ${p.downloading} down` : ''}`;
      if (params.project === undefined) return done([`${link.user.email}${link.online ? '' : ' (offline)'}`, ...link.projects.filter(p => p.kept).map(line)].join('\n'));
      const want = String(params.project).replace(/^@/, ''), low = want.toLowerCase();
      const hits = link.projects.filter(p => p.id === want || handle(p.id).slice(1) === want || p.name.toLowerCase() === low);
      if (hits.length !== 1) throw new Error(hits.length ? `"${want}" matches ${hits.length} projects; use the code.` : `No sharedcut.com project "${want}".`);
      const after = await direct<{ projects: Kept[] }>(`/remote/projects/${encodeURIComponent(hits[0].id)}`, { method: params.stop === true ? 'DELETE' : 'PUT' });
      return done(line(after.projects.find(p => p.id === hits[0].id) ?? hits[0]));
    },
  },
  'restore-project': {
    doc: '{id?} no id = your deleted projects (7 days); id (code or name) restores one, media included',
    async start(params) {
      const { projects } = await call<{ projects: { id: string; name: string; expiresAt: number }[] }>('/projects/deleted');
      if (params.id === undefined) return done(projects.map(p => `${handle(p.id).slice(1)} ${quote(p.name)} · until ${day(p.expiresAt)}`).join('\n') || 'Nothing deleted in the last 7 days.');
      const want = String(params.id).replace(/^@/, ''), low = want.toLowerCase();
      const hits = projects.filter(p => p.id === want || handle(p.id).slice(1) === want || p.name.toLowerCase() === low);
      if (hits.length !== 1) throw new Error(hits.length ? `"${want}" matches ${hits.length} deleted projects; use the code.` : `No deleted project "${want}". job restore-project{} lists them.`);
      const id = hits[0].id;
      await direct(`${path(id)}/restore`, { method: 'POST', json: {} });
      // The server marks media whose processing the delete cancelled; retryMedia needs the project open.
      const failed = store.getState().media.filter(m => m.projectId === id && m.status === 'failed' && m.error?.startsWith('Processing was interrupted')).map(m => handle(m.id));
      return done(`restored ${handle(id)} ${quote(hits[0].name)} · open with projects{open:"${handle(id)}"}${failed.length ? `, then act retryMedia for each interrupted media: ${failed.join(' ')}` : ''}`);
    },
  },
  history: {
    doc: '{limit?=12, all?} open project: recent edits, snapshots, open comments (all: resolved too) with ids. help history',
    async start(params) {
      const s = store.getState(), p = project(), limit = Math.max(1, Math.min(100, Number(params.limit) || 12));
      const who = (id: string) => id === s.currentUserId ? 'you' : s.users.find(u => u.id === id)?.name ?? '?';
      const ops = s.operations.filter(o => o.projectId === p.id).slice(0, limit)
        .map(o => `${handle(o.id)} ${ago(o.timestamp)} ${who(o.userId)}: ${quote(o.description)}${o.undone && !o.description.startsWith('undid:') ? ' [undone]' : ''}`);
      const snaps = s.snapshots.filter(x => x.projectId === p.id).slice(0, limit)
        .map(x => `${handle(x.id)} ${quote(x.name)} ${who(x.userId)} ${ago(x.timestamp)}${x.note ? ` · ${quote(x.note, 50)}` : ''}`);
      const notes = s.comments.filter(c => c.projectId === p.id && (params.all || !c.resolved)).sort((a, b) => (a.range?.[0] ?? a.time) - (b.range?.[0] ?? b.time))
        .map(c => `${handle(c.id)} ${c.resolved ? '[resolved] ' : ''}${clock(c.range?.[0] ?? c.time)}${c.range ? `–${clock(c.range[1])}` : ''} ${who(c.userId)}: ${quote(c.text, 80)}${c.replies.length ? ` (${c.replies.length} replies)` : ''}${c.clipId ? ` clip ${handle(c.clipId)}` : ''}${c.timelineId && c.timelineId !== s.timelineId ? ` on ${handle(c.timelineId)}` : ''}`);
      return done([`edits (newest first):${ops.length ? '' : ' none'}`, ...ops, `snapshots:${snaps.length ? '' : ' none'}`, ...snaps, `${params.all ? 'comments' : 'open comments'}:${notes.length ? '' : ' none'}`, ...notes].join('\n'));
    },
  },
};

// ---- help topics ----

/** Settings rows parsed from the Settings dialog itself, so a new preference shows up here with no MCP change. */
function settingsRows() {
  try {
    const source = appFile('src/components/SettingsDialog.tsx');
    const named: Record<string, readonly string[]> = { transitionNames };
    const rows: string[] = [];
    for (const m of source.matchAll(/\b(select|toggle|textField)\('([^']*)',\s*'[^']*',\s*'(\w+)'(?:,\s*(\[[^\]]*\]|\w+))?(?:,\s*([^)]*?))?\)/g)) {
      const [, kind, label, key, options, fallback] = m;
      const values = kind === 'select' ? (options?.startsWith('[') ? [...options.matchAll(/'([^']*)'/g)].map(x => x[1]) : named[options ?? ''] ?? []) : [];
      const initial = kind === 'toggle' ? (options ?? 'true') : (fallback?.replace(/'/g, '') || values[0] || '');
      rows.push(`${key}: ${kind === 'toggle' ? 'true|false' : values.join('|') || 'text'} (default ${initial}) · ${label}`);
    }
    return rows;
  } catch { return ['(could not read src/components/SettingsDialog.tsx)']; }
}

/** Inspector clip properties: unit and meaning here; default, range and animatable come from the app. */
const INSPECTOR: Record<string, string> = {
  x: 'px from frame centre', y: 'px from frame centre', zoom: '%', scaleX: '% width stretch × zoom', scaleY: '% height stretch × zoom', rotation: '°', anchorX: 'px pivot offset', anchorY: 'px pivot offset', flipH: 'mirror',
  motionBlur: 'blur animated position/scale', motionBlurStrength: '% shutter (50 = half frame)', motionBlurSamples: '16|32|64 quality',
  cropLeft: 'px of the source, ≤ its width', cropRight: 'px, ≤ source width', cropTop: 'px, ≤ source height', cropBottom: 'px, ≤ source height',
  opacity: '%', fadeIn: 's, ≤ clip duration', fadeOut: 's, ≤ clip duration', blendMode: 'one of the blendMode names above',
  speed: '% · changes duration · whole link group (help motion)', reverse: 'link group', freeze: 'link group', opticalFlow: 'interpolate slow motion (help motion)',
  gain: 'dB (updateProperty allows up to 24)', pan: '−100 left … 100 right', audioFadeIn: 's, ≤ clip duration', audioFadeOut: 's, ≤ clip duration',
  normalize: 'export loudness normalize', normalizeTarget: `LUFS ${loudnessTargets.map(t => `${t.lufs} ${t.label}`).join(' | ')}`,
  disabled: 'clip off (writes clip.disabled)',
};
function propertyRows() {
  const values: Clip['properties'] = { ...defaultProperties, flipH: false, motionBlur: false, motionBlurStrength: 50, motionBlurSamples: 32, fadeIn: 0, fadeOut: 0, opticalFlow: false, audioFadeIn: 0, audioFadeOut: 0, normalize: false, normalizeTarget: loudnessTargets[0].lufs };
  const probe = { id: 'probe', projectId: '', timelineId: '', trackId: '', mediaId: '', name: '', start: 0, duration: 10, sourceIn: 0, properties: values, effects: [], disabled: false } as unknown as Clip;
  const animatable = new Set(animationProperties(probe).map(p => p.path));
  return Object.entries(INSPECTOR).map(([key, note]) => {
    const path = `properties.${key}`, lo = boundedAnimationValue(path, -1e9), hi = boundedAnimationValue(path, 1e9);
    const range = typeof lo === 'number' && lo > -1e9 && !/[≤|]/.test(note) ? ` (${lo}–${hi})` : '';
    return `${key}=${key === 'disabled' ? false : values[key]}${range} ${note}${animatable.has(path) ? '' : ' · not animatable'}`;
  });
}

export const topics: Record<string, string> = {
  keyframes: [
    'keyframes: animate any clip value over time. Times are CLIP-relative seconds (0 = clip start). act unless noted.',
    'A clip with keyframes cannot be part of a transition: export refuses it (act notes it when a batch makes one).',
    'paths: properties.<key> (help properties marks the animatable ones) · effects.<effectId>.enabled|amount|parameters.<key> (help effects) · nodes.<nodeId>.enabled|parameters.<key> (grade nodes) · text.<field> on titles (e.g. text.opacity, text.runs.0.style.color) · shape.<field> on shapes. Caption clips: none. The effect or node must exist first; its id is on the timeline line (fx Name@…) or in get{id:clip}.',
    'Keyframe = {id, time, value, interpolation:"linear"|"hold"|"bezier", curve?:[x1,y1,x2,y2]} (x in 0–1; ease in-out [0.42,0,0.58,1]). id: any string unique in the channel ("k1"). value must have the property\'s current type (number|boolean|string; #rrggbb strings blend). interpolation is required (keyframeProperty picks linear for numbers, hold otherwise).',
    'whole channel: setKeyframes(clip, path, [keys], gesture?) · [] clears it. Example: ["setKeyframes","@c","properties.zoom",[{"id":"a","time":0,"value":100,"interpolation":"bezier","curve":[0.42,0,0.58,1]},{"id":"b","time":2,"value":120,"interpolation":"linear"}]]',
    'one key at the playhead: act{at:<timeline seconds inside the clip>, do:[["keyframeProperty", clip, path, value?]]} adds or replaces the key on that frame (value omitted = current value).',
    'on a property that has keys, updateProperty(clip,key,v) sets a key at the playhead instead of the static value; clear the channel to go static again.',
    'all channels at once: setAnimationChannels(clip, {path:[keys], …}, gesture?) · paths left out are REMOVED.',
    'one undo step: pass the same gesture string as the last argument of every setKeyframes/updateProperty/updateEffect/updateNode in one act call (updateProperty on a keyed property drops it). Use a new string each call ("g7"): undo takes every edit of yours that shares it.',
    'values clamp to the animation range (opacity 0–100, zoom/scaleX/scaleY 1–800, rotation ±360, gain −60–12, text.x ±4 …). speed/reverse/freeze keys retime the whole link group (ramps: help motion).',
    'read: get{id:clip, path:"keyframes"}; the timeline line lists keyed paths as kf …. A wrong path, type or duplicate time changes nothing (act notes "changed nothing").',
  ].join('\n'),
  ids: [
    'ids: every id prints as an @handle, the first 8 characters of its uuid plus any suffix (clip-3fa9c1d2-… → @3fa9c1d2; a track …-v3 → @786fb0b9-v3). Short ids print whole (@broll).',
    'Pass handles back exactly as printed, at any depth in act/job/get/frame args. A unique prefix of 4+ characters works too; an unknown or ambiguous handle is an error: look again.',
    'Full ids work too. Strings without a leading @ pass through untouched: names, and ids you make up yourself (keyframe ids, gesture strings).',
    'New things get ids from the action: read them in the act reply (+ clip @…) or the return line (createProject → @…, addMarker → @…).',
    'where: projects (projects) · timeline (tracks, clips, fx effects, markers, other timelines) · media (assets, bins) · job history (edits, snapshots, comments) · job project (people) · job plan (scripts, script lines, shots, board cards) · get{id} (effects, masks, trackers, keyframes, caption sets).',
    'Deleted projects are not loaded, so no handle resolves to them: job restore-project takes the bare code it prints (no @) or the name.',
  ].join('\n'),
  history: [
    'history: undo/redo, snapshots, comments and markers in the open project. job history{} lists edits, snapshots and comments with ids.',
    'undo/redo: act undo, act redo. Undo is personal: your newest not-undone edit in the OPEN project (steps that share a gesture go together). Refused ("Cannot undo without overwriting a newer change") when anyone\'s later edit touches the same thing or the values changed since.',
    'redo is a new edit; the redo list lives only in this MCP process and any new edit of yours clears it. Same account as the user = their ⌘Z undoes your edits and yours theirs.',
    'one act call with several edits = several undo steps unless they share a gesture argument (help keyframes). Format changes (setTimelineFormat) and snapshots are not undoable.',
    'snapshots: saveSnapshot(name ≤100, note ≤1000) stores a full copy of the project; it cannot be edited, deleted or undone. restoreSnapshot(id) first saves "Before restoring …", then replaces every clip, track, grade node and comment as one undoable edit; refused while a collaborator holds a lock (wait, retry).',
    'comments (Commenter role is enough): act{at:<seconds>, do:[["addComment", text, {clipId?, range?:[from,to]}]]} pins it at the playhead on the current timeline. replyComment(id, text). resolveComment(id) TOGGLES: check [resolved] in job history{all:true} first.',
    'markers (current timeline): addMarker({name?, color?, note?, time?}) → id; time defaults to the playhead, name to "Marker N", color to yours. Edit: setMarkers(full list with the entry changed, "description"); read the list with get{id:timeline, path:"markers"}. deleteMarkers([ids]). Times clamp to the timeline, the list stays sorted; each call is one undoable edit.',
    'job history lines: "undid: …" are undo records; [undone] marks an edit that was undone.',
  ].join('\n'),
  settings: [
    'settings: per-account preferences. act setSettings({key: value, …}); values are strings/numbers/booleans exactly as listed. They follow the account everywhere: on the user\'s own account this changes their editor.',
    'Ones that change what actions do: timelineResolution/timelineFrameRate = createProject\'s format · stillDuration = image length on addMediaToTimeline · defaultTransition/defaultTransitionDuration = applyTransitionAtPlayhead · linkSelection = linked video+audio select and move together · masterGain (dB −60–6)/masterMuted (true|false) = export mix. The rest only affect the browser.',
    ...settingsRows(),
    'Never set the layout keys (mediaWidth, inspectorWidth, timelineHeight, mediaPanelWidth, inspectorPanelWidth, editorSplit) or lastProjectId.',
    'profile: act setUserProfile({name, email}) · setUserColor("#rrggbb") (sent to the server, then reloaded).',
  ].join('\n'),
  properties: [
    'Inspector keys: key=default (animation range) unit/meaning. act updateProperty(clip, key, value, gesture?) clamps and refuses keys with "." in them; on a keyed property it sets a key at the playhead (help keyframes).',
    ...propertyRows(),
  ].join('\n'),
};
