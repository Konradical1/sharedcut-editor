// Create an empty project (timeline + four tracks) through PATCH /api/state, with the ids
// scripts/import-folder.mjs derives, so a later import resumes into it. Does nothing if it exists.
//
//   node scripts/agent/create-project.mjs "fisch.builds Part 1" [resolution] [fps]
import { createHash } from 'node:crypto';
import { agentCookie, patchState } from '../state-patch.mjs';

const [name, resolution = '1080 × 1920', fpsArg = '30'] = process.argv.slice(2);
if (!name) throw new Error('Pass a project name.');
const fps = Number(fpsArg), server = (process.env.FRAME_LINE_URL ?? 'http://127.0.0.1:4310').replace(/\/$/, ''), cookie = agentCookie();
const id = (prefix, value) => `${prefix}-${createHash('sha1').update(value).digest('hex')}`;
const call = async (path, init = {}) => {
  const response = await fetch(server + path, { ...init, headers: { cookie, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  const text = await response.text();
  if (!response.ok) { const error = new Error(`${path} -> ${response.status} ${text.slice(0, 300)}`); error.status = response.status; throw error; }
  return text ? JSON.parse(text) : null;
};
const me = (await call('/api/auth/me')).user;
if (!me) throw new Error('Cookie rejected; run agent-session.mjs again.');
const projectId = id('project', `${me.id}:${name}`), timelineId = id('timeline', projectId);
let existing;
await patchState(call, state => {
  existing = state.projects.find(p => p.id === projectId || p.name === name);
  if (existing) return null;
  return {
    projects: { upsert: [{ id: projectId, name, description: '', thumbnail: '', modifiedAt: Date.now(), duration: 0, resolution, fps, shared: false, status: 'In progress', members: [] }], remove: [] },
    timelines: { upsert: [{ id: timelineId, projectId, name, duration: 60 }], remove: [] },
    tracks: { upsert: [['v2', 'B-roll', 'video', 2], ['v1', 'Main picture', 'video', 1], ['a1', 'Dialogue', 'audio', 1], ['a2', 'Music', 'audio', 2]]
      .map(([slug, n, kind, number]) => ({ id: id('track', `${timelineId}:${slug}`), timelineId, name: n, kind, number, muted: false, solo: false, locked: false, hidden: false, gain: kind === 'audio' && number !== 1 ? -12 : 0, pan: 0 })), remove: [] },
  };
});
console.log(JSON.stringify(existing ? { exists: true, projectId: existing.id, name } : { created: true, projectId, timelineId, name, resolution, fps }));
