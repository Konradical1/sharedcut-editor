import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** FRAME_LINE_COOKIE, else the cookie scripts/agent/agent-session.mjs saved in ~/sharedcut-agent/cookie.txt. */
export function agentCookie() {
  const file = join(homedir(), 'sharedcut-agent', 'cookie.txt');
  return process.env.FRAME_LINE_COOKIE ?? (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
}

// Send one change to /api/state as a delta. A PUT of the whole state fails once it passes the 20 MiB body
// limit and overwrites anything saved meanwhile; a delta is small, and a 409 just means re-read and redo.
// Background preparation bumps the revision on every progress tick, so a busy server needs many tries.
export async function patchState(call, build, attempts = 30) {
  for (let attempt = 1; ; attempt++) {
    const view = await call('/api/state');
    const delta = build(view.state);
    if (!delta || !Object.keys(delta).length) return view;
    try { return await call('/api/state', { method: 'PATCH', body: JSON.stringify({ revision: view.revision, delta }) }); }
    catch (error) {
      if (error.status !== 409 || attempt >= attempts) throw error;
      await new Promise(r => setTimeout(r, Math.min(2000, 100 * attempt) + Math.random() * 200));
    }
  }
}
