// The MCP must reach every feature. This fails when a store action or a server route appears that the MCP neither
// exposes nor explicitly rules out, and when a job loses its manual. Fix it in the same commit as the feature:
// classify the action in ACTIONS (mcp/catalog.ts), or add a job / a ROUTES entry below.
import './env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTIONS, storeMembers, topicNames } from './catalog.ts';
import { JOBS } from './jobs.ts';

/**
 * Every /api route in server/index.ts, keyed exactly as it appears there, and how the MCP reaches it:
 *   session          the MCP's own sign-in and sync (mcp/session.ts, mcp/setup.ts)
 *   frame            the frame tool (mcp/frame.ts)
 *   job:<kind>       a job (checked against JOBS)
 *   store:<action>   a store action the model runs through act (checked against ACTIONS)
 *   no: <reason>     deliberately not offered
 */
export const ROUTES: Record<string, string> = {
  '/api/showcase/([a-z0-9-]+)/([a-zA-Z0-9_.-]+)': 'job:showcase',
  '/api/health': 'no: a liveness probe for the tunnel and npm run doctor',
  '/api/uploads/info': 'job:upload',
  '/api/auth/me': 'session',
  '/api/auth/login': 'session',
  '/api/auth/signup': 'no: accounts are made by people in the browser',
  '/api/auth/guest': 'no: guests are people typing their name at sharedcut.com/importer; the MCP runs as a signed-in account',
  '/api/uploads/probe': 'no: the importer page times its own Wi-Fi before an upload; the MCP reports its real upload rate',
  '/api/auth/logout': 'no: it would revoke the session the MCP runs on; the api tool refuses it',
  '/api/auth/profile': 'store:setUserProfile',
  '/api/state': 'session',
  '/api/events': 'no: live push for browsers; the MCP catches up with GET /api/state?since= before every call',
  '/api/presence': 'no: the agent signs in as the user, and its presence would replace their own tab for collaborators',
  '/api/locks': 'no: locks guard a person mid-drag; the MCP saves in one step and honours other people\'s locks from the state envelope',
  '/api/health/report': 'no: playback health for the host owner, not editing',
  '/api/timeline-previews': 'no: playback preview chunks for browsers; frame renders stills with /api/frames',
  '/api/timeline-previews/([a-f0-9]{64})/video\\.mp4': 'no: as /api/timeline-previews',
  '/api/frames': 'frame',
  // Media
  '/api/media': 'job:upload',
  '/api/media/([a-zA-Z0-9_-]+)(?:/(.*))?': 'job:upload', // upload, replace, original, files; PATCH/retry/DELETE are act renameMedia/retryMedia/removeMedia
  '/api/media/import-link': 'job:link',
  '/api/media/still': 'job:still',
  '/api/media/move': 'store:moveMedia',
  // Projects and sharing
  '/api/projects/([a-zA-Z0-9_-]+)': 'job:project', // PATCH; DELETE is job delete-project
  '/api/projects/([a-zA-Z0-9_-]+)/members/([a-zA-Z0-9_-]+)': 'job:member',
  '/api/projects/deleted': 'job:restore-project',
  '/api/projects/([a-zA-Z0-9_-]+)/restore': 'job:restore-project',
  '/api/projects/([a-zA-Z0-9_-]+)/lock': 'job:lock-project',
  // SharedCut Desktop's link to sharedcut.com (server/remoteSync.ts)
  '/api/remote*': 'job:keep-offline',
  '/api/remote': 'job:keep-offline',
  '/api/remote/projects/([a-zA-Z0-9_-]+)': 'job:keep-offline',
  '/api/remote/login': 'no: a person types their sharedcut.com password into the desktop app; the MCP never handles passwords',
  '/api/remote/logout': 'no: signing the desktop app out of sharedcut.com stops its sync; that is the person\'s call',
  '/api/library': 'job:folder',
  // Captions, masks, depth, motion, tracking, color
  '/api/captions': 'job:captions',
  '/api/captions/([a-zA-Z0-9_-]+)': 'job:captions',
  '/api/smart-masks/capabilities': 'job:mask-guide',
  '/api/smart-masks/source': 'job:mask-view',
  '/api/smart-masks/source-times': 'no: same frame times as /api/motion-trackers/source-times, which the MCP uses because this one also starts the SAM worker',
  '/api/smart-masks/preview': 'job:mask-guide',
  '/api/smart-masks/preview/([a-f0-9]{64})\\.png': 'job:mask-guide',
  '/api/smart-masks': 'job:mask-analyze',
  '/api/smart-masks/([a-f0-9]{64})(?:/(manifest|frames|preview|source)(?:/(\\d+)\\.(png|jpg))?)?': 'job:mask-analyze',
  '/api/depth/capabilities': 'job:depth',
  '/api/depth': 'job:depth',
  '/api/depth/([a-f0-9]{64})(?:/preview/(\\d+)\\.mp4|/(focus))?': 'job:depth-probe',
  '/api/stabilize/capabilities': 'job:stabilize',
  '/api/stabilize': 'job:stabilize',
  '/api/stabilize/([a-f0-9]{64})': 'job:stabilize',
  '/api/optical-flow/capabilities': 'job:flow',
  '/api/optical-flow': 'no: flow preview chunks only feed browser playback; export bakes optical flow from the original itself',
  '/api/optical-flow/([a-f0-9]{64})(?:/(video))?': 'no: as /api/optical-flow',
  '/api/denoise/capabilities': 'job:denoise',
  '/api/denoise': 'no: preview chunks only feed browser playback; export bakes from the original',
  '/api/denoise/all': 'job:denoise-all',
  '/api/denoise/([a-f0-9]{64})(?:/files/video\\.mp4)?': 'no: as /api/denoise',
  '/api/motion-trackers/*': 'job:track',
  '/api/motion-trackers/capabilities': 'job:track',
  '/api/motion-trackers/source-times': 'job:track-frame',
  '/api/motion-trackers/track': 'job:track',
  '/api/motion-trackers/jobs/([a-f0-9-]{36})': 'job:track',
  '/api/motion-trackers/clear': 'job:track-clear',
  '/api/motion-trackers/samples/([a-f0-9]{64})': 'job:track',
  '/api/color-assistant/capabilities': 'job:color-looks',
  '/api/projects/([a-zA-Z0-9_-]+)/color-assistant(?:/([a-f0-9-]{36})(?:/stills/([^/]+))?)?': 'job:color-looks',
  '/api/projects/([a-zA-Z0-9_-]+)/color-normalize(?:/([a-f0-9-]{36}|capabilities))?': 'job:color-normalize', // capabilities: the job's start fails with the same reason; on SharedCut Desktop it runs on sharedcut.com
  // Export and Resolve
  '/api/renders': 'job:export',
  '/api/renders/([a-zA-Z0-9_-]+)(?:/(download))?': 'job:exports',
  '/api/projects/([a-zA-Z0-9_-]+)/resolve-export': 'job:resolve',
  '/api/projects/([a-zA-Z0-9_-]+)/resolve/([a-zA-Z0-9_.-]+)': 'job:resolve',
  '/api/resolve/bridge': 'job:resolve',
  '/api/resolve/import': 'job:resolve',
  '/api/fcp/import': 'job:fcp',
  '/api/fcp/import/(fcp-[a-zA-Z0-9_-]{1,60})': 'job:fcp',
  // Shared libraries
  '/api/sfx': 'job:sfx', // GET search; POST (save a clip) is job sfx-save
  '/api/sfx/(sfx-[a-zA-Z0-9-]+)/(preview|import)': 'job:sfx-add',
  '/api/fonts': 'job:font', // GET is job fonts
  '/api/fonts/(FL-[a-f0-9]{32})': 'no: font bytes for the browser\'s FontFace; exports load fonts on the server',
  '/api/transitions': 'job:overlay', // GET is job overlays (and loaded at connect)
  '/api/transitions/([a-z0-9][a-z0-9-]{0,78}[a-z0-9])\\.(mp4|jpg)': 'job:overlay',
  '/api/transitions/presets': 'store:saveTransitionPreset',
  '/api/transitions/favorites': 'store:toggleTransitionFavorite',
};

const SERVER = fileURLToPath(new URL('../server/index.ts', import.meta.url));
/** The route literals of server/index.ts: exact paths, path lists, prefixes and route regexes. */
export function serverRoutes(source = readFileSync(SERVER, 'utf8')) {
  const routes = new Set<string>();
  for (const m of source.matchAll(/path\s*===\s*'(\/api\/[^']+)'/g)) routes.add(m[1]);
  for (const m of source.matchAll(/\[((?:\s*'\/api\/[^']+'\s*,?)+)\]\.includes\(path\)/g)) for (const r of m[1].matchAll(/'(\/api\/[^']+)'/g)) routes.add(r[1]);
  for (const m of source.matchAll(/path\.startsWith\('(\/api\/[^']+)'\)/g)) routes.add(`${m[1]}*`);
  for (const m of source.matchAll(/\/\^(\\\/api\\\/.*?)\$\/\.exec\(path\)/g)) routes.add(m[1].replace(/\\\//g, '/'));
  return [...routes].sort();
}

test('every store action is exposed, routed to a job, or ruled out', () => {
  const methods = storeMembers().filter(m => m.method).map(m => m.name);
  assert.ok(methods.length > 100, 'the EditorStore parser found too few methods; check storeMembers()');
  const missing = methods.filter(name => !(name in ACTIONS));
  assert.deepEqual(missing, [], `New store actions need a line in ACTIONS (mcp/catalog.ts): ${missing.join(', ')}`);
  const stale = Object.keys(ACTIONS).filter(name => !methods.includes(name));
  assert.deepEqual(stale, [], `ACTIONS names actions the store no longer has: ${stale.join(', ')}`);
  for (const [name, kind] of Object.entries(ACTIONS)) if (kind.startsWith('job:')) assert.ok(JOBS[kind.slice(4)], `${name} points at job "${kind.slice(4)}", which does not exist`);
});

test('every server route is reachable from the MCP or ruled out with a reason', () => {
  const routes = serverRoutes();
  assert.ok(routes.length > 40, 'the route parser found too few routes; check serverRoutes()');
  const missing = routes.filter(route => !(route in ROUTES));
  assert.deepEqual(missing, [], `New server routes need a ROUTES entry in mcp/coverage.test.ts (a job, a store action, or "no: why"):\n${missing.join('\n')}`);
  const stale = Object.keys(ROUTES).filter(route => !routes.includes(route));
  assert.deepEqual(stale, [], `ROUTES lists routes the server no longer has: ${stale.join(', ')}`);
  for (const [route, how] of Object.entries(ROUTES)) {
    assert.match(how, /^(session|frame|job:[\w-]+|store:\w+|no: .{10,})$/, `${route}: say how the MCP reaches it`);
    if (how.startsWith('job:')) assert.ok(JOBS[how.slice(4)], `${route} names job "${how.slice(4)}", which does not exist`);
    if (how.startsWith('store:')) assert.ok(ACTIONS[how.slice(6)] && ACTIONS[how.slice(6)] !== 'hidden', `${route} names store action "${how.slice(6)}", which act cannot run`);
  }
});

test('every job has a one-line manual and help covers it', () => {
  for (const [kind, job] of Object.entries(JOBS)) {
    assert.match(kind, /^[a-z][a-z-]*$/, `job kind "${kind}" should be lowercase-hyphenated`);
    assert.ok(job.doc && !job.doc.includes('\n') && job.doc.length <= 240, `job "${kind}" needs a one-line doc of at most 240 characters`);
  }
  for (const topic of ['actions', 'effects', 'transitions', 'titles', 'shapes', 'properties', 'jobs']) assert.ok(topicNames().includes(topic), `help topic "${topic}" is missing`);
});
