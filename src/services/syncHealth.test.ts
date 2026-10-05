import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersistedState } from './index.ts';
import type { Project, User } from '../state/models.ts';
import type { PlaybackReport } from './playbackReportTypes.ts';
import { createHealthReporter, installHealthReporter } from './playbackHealth.ts';

type Sent = { health?: PlaybackReport; playhead: number };

/** A signed-in tab in a project, against a fake server that records every presence post. */
async function inProject(run: (tab: { sent: Sent[]; store: typeof import('../state/store.ts').useEditorStore; post: (playhead: number) => Promise<void> }) => Promise<void>) {
  const storage = new Map<string, string>(), keys = ['localStorage', 'window', 'fetch'];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const location = { pathname: '/' };
  define('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  define('window', Object.assign(new EventTarget(), { location }));
  const alice: User = { id: 'alice', name: 'alice', email: 'alice@test.local', color: '#abcdef', initials: 'a' };
  const remote: PersistedState = { projects: [{ id: 'p', name: 'P', description: '', members: [{ userId: 'alice', role: 'Owner' }] } as Project], media: [], timelines: [], tracks: [], clips: [], nodes: [], comments: [], operations: [], snapshots: [], renderJobs: [], users: [alice], currentUserId: 'alice', settings: { uiScale: '100%', timelineDensity: 'comfortable', reducedMotion: false } };
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const sent: Sent[] = [];
  define('fetch', async (url: string, options: RequestInit = {}) => {
    const target = new URL(String(url), 'http://test.local');
    if (target.pathname === '/api/auth/me') return json({ user: alice });
    if (target.pathname === '/api/auth/logout') return json({ ok: true });
    if (target.pathname === '/api/presence') { sent.push(JSON.parse(String(options.body))); return json({ presence: [], serverTime: Date.now() }); }
    return json({ revision: 1, lockRevision: 0, state: structuredClone(remote), presence: [], locks: [] });
  });
  const { useEditorStore: store } = await import('../state/store.ts');
  const sync = await import('./sync.ts');
  const settle = async (ready: () => boolean) => { for (let i = 0; i < 400 && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  // Changing the playhead changes what presence says, so the next 50 ms tick posts at once.
  const post = async (playhead: number) => { const before = sent.length; store.setState({ playhead }); await settle(() => sent.length > before); assert.ok(sent.length > before, 'a presence post went out'); };
  try {
    await sync.connectSession();
    location.pathname = '/project/p'; store.setState({ projectId: 'p', timelineId: 't' });
    await run({ sent, store, post });
  } finally {
    await sync.signOut().catch(() => {});
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
}

/** A real reporter on a fake clock that has just watched 11 s of smooth playing, so a report is due. */
function dueReporter(state: { sharing: boolean }) {
  const clock = { t: 1_000 }, win = new EventTarget();
  const reporter = createHealthReporter({
    now: () => clock.t, target: win, build: 'it-build', sharing: () => state.sharing,
    device: () => ({ cores: 8, memoryGB: 8, gpu: 'GPU', agent: 'Chrome', netType: '4g', rttMs: 30, downlinkMbps: 20, saveData: false, harness: false, onHost: false }),
    context: () => ({ quality: 'Stream', source: 'stream', cachedPct: 50 }), targetFps: () => 30, observe: () => null,
  });
  for (let elapsed = 0; elapsed < 11_000; elapsed += 33) {
    clock.t += 33;
    win.dispatchEvent(new CustomEvent('frameline:frame', { detail: { dataset: { sourceClip: 'c', sourceTimestamp: String(clock.t), playbackEngine: 'webcodecs' } } }));
    win.dispatchEvent(new CustomEvent('frameline:playback-health', { detail: { playing: true, playhead: 3, loading: false, engine: 'webcodecs', reason: '' } }));
  }
  return reporter;
}

test('the presence heartbeat carries the playback report only when sharing is on and a report is due', async () => {
  const state = { sharing: false };
  const reporter = dueReporter(state);
  const uninstall = installHealthReporter(reporter);
  try {
    await inProject(async ({ sent, post }) => {
      await post(1);
      assert.equal(sent.some(body => 'health' in body), false, 'sharing off: a report is due but nothing is sent');
      state.sharing = true;
      await post(2);
      const carrying = sent.filter(body => body.health);
      assert.equal(carrying.length, 1, 'sharing on: the due report goes out once');
      assert.equal(carrying[0].health!.v, 1);
      assert.equal(carrying[0].health!.build, 'it-build');
      await post(3);
      assert.equal(sent.filter(body => body.health).length, 1, 'not due again: the next post is a plain heartbeat');
    });
  } finally { uninstall(); reporter.stop(); }
});

test('with no reporter installed (not in the editor) the heartbeat is unchanged', async () => {
  await inProject(async ({ sent, post }) => {
    await post(1);
    assert.equal(sent.length > 0 && sent.every(body => !('health' in body)), true);
  });
});
