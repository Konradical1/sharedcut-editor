import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import type { PersistedState } from './index.ts';
import type { Project, User } from '../state/models.ts';

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0; url: string; handlers = new Map<string, ((event: MessageEvent) => void)[]>();
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
  addEventListener(type: string, handler: (event: MessageEvent) => void) { this.handlers.set(type, [...this.handlers.get(type) ?? [], handler]); }
  close() { this.readyState = 2; }
  emit(type: string, readyState: number, data: unknown = {}) { this.readyState = readyState; for (const handler of this.handlers.get(type) ?? []) handler({ data: JSON.stringify(data) } as MessageEvent); }
}
const lock = (id: string) => ({ id, projectId: 'p', targetId: 'p', field: '*', userId: 'bob', expiresAt: Date.now() + 60_000 });

/** A signed-in tab against a fake server that can restart (new start stamp, lock counter back near zero). */
async function withTab(run: (tab: { server: { revision: number; lockRevision: number; startedAt: number | undefined; locks: unknown[]; gets: number }; store: typeof import('../state/store.ts').useEditorStore; sync: typeof import('./sync.ts'); sources: FakeEventSource[]; tick: (ms: number) => Promise<void> }) => Promise<void>) {
  const storage = new Map<string, string>(), keys = ['localStorage', 'window', 'EventSource', 'fetch'];
  const saved = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  define('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  define('window', Object.assign(new EventTarget(), { location: { pathname: '/' } }));
  FakeEventSource.instances = [];
  define('EventSource', FakeEventSource);
  const alice: User = { id: 'alice', name: 'alice', email: 'alice@test.local', color: '#abcdef', initials: 'a' };
  const remote: PersistedState = { projects: [{ id: 'p', name: 'P', description: '', members: [{ userId: 'alice', role: 'Owner' }] } as Project], media: [], timelines: [], tracks: [], clips: [], nodes: [], comments: [], operations: [], snapshots: [], renderJobs: [], users: [alice], currentUserId: 'alice', settings: { uiScale: '100%', timelineDensity: 'comfortable', reducedMotion: false } };
  const server = { revision: 1, lockRevision: 57, startedAt: 1000 as number | undefined, locks: [] as unknown[], gets: 0 };
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  define('fetch', async (url: string, options: RequestInit = {}) => {
    const target = new URL(String(url), 'http://test.local'), route = target.pathname;
    if (route === '/api/auth/me') return json({ user: alice });
    if (route === '/api/auth/logout') return json({ ok: true });
    if (route === '/api/transitions') return json({ leaks: [], presets: [], favorites: [] });
    if (route === '/api/presence') return json({ presence: [], serverTime: Date.now() });
    if (route !== '/api/state' || (options.method && options.method !== 'GET')) return json({ error: 'Not found.' }, 404);
    server.gets++;
    const head = { revision: server.revision, lockRevision: server.lockRevision, ...(server.startedAt === undefined ? {} : { serverStartedAt: server.startedAt }), presence: [], locks: server.locks };
    // A caller that already holds this revision gets the ephemeral half only, as the real server answers it.
    return json(target.searchParams.get('since') === String(server.revision) ? head : { ...head, state: structuredClone(remote) });
  });
  const { useEditorStore: store } = await import('../state/store.ts');
  const sync = await import('./sync.ts');
  try {
    await sync.connectSession();
    await run({ server, store, sync, sources: FakeEventSource.instances, tick: async ms => { mock.timers.tick(ms); await settle(); } });
  } finally {
    mock.timers.reset();
    await sync.signOut().catch(() => {});
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
}

test('after a server restart the tab takes lock updates again, though the new counter is far below the old one', async () => {
  await withTab(async ({ server, store, sync }) => {
    const heldIds = () => store.getState().locks.map(item => item.id);
    server.lockRevision = 58; server.locks = [lock('a')]; await sync.refreshState();
    assert.deepEqual(heldIds(), ['a'], 'a normal lock update');
    // The restarted server counts lock changes from zero again and stamps its new start time.
    server.startedAt = 2000; server.lockRevision = 1; server.locks = [lock('b')]; await sync.refreshState();
    assert.deepEqual(heldIds(), ['b'], 'the collaborator\'s lock is visible after the restart');
    // The same process answering out of order is still ignored, as before.
    server.lockRevision = 0; server.locks = []; await sync.refreshState();
    assert.deepEqual(heldIds(), ['b'], 'a stale answer from the same server run changes nothing');
    // A rollback to a build that does not stamp its start is a restart too.
    server.startedAt = undefined; server.lockRevision = 0; server.locks = [lock('c')]; await sync.refreshState();
    assert.deepEqual(heldIds(), ['c']);
  });
});

test('an older server that never stamps its start behaves exactly as before', async () => {
  await withTab(async ({ server, store, sync }) => {
    server.startedAt = undefined;
    await sync.connectSession();
    server.lockRevision = 60; server.locks = [lock('a')]; await sync.refreshState();
    server.lockRevision = 59; server.locks = []; await sync.refreshState();
    assert.deepEqual(store.getState().locks.map(item => item.id), ['a'], 'an older counter is still dropped');
  });
});

test('a live-update stream the server refused is reopened with a growing wait, and stopped on sign-out', async () => {
  await withTab(async ({ sources, store, sync, tick }) => {
    assert.equal(sources.length, 1, 'one stream while connected');
    mock.timers.enable({ apis: ['setTimeout'] });
    sources[0].emit('error', 0);
    await tick(120_000);
    assert.equal(sources.length, 1, 'the browser is already retrying a stream that is merely connecting');
    assert.equal(store.getState().serverOnline, false);
    // Closed for good (a 502 from the tunnel while the origin restarts): each wait is 0.5-1 s, 1-2 s, 2-4 s ... at most 30 s.
    let expected = 1;
    for (const base of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      sources.at(-1)!.emit('error', 2);
      await tick(Math.ceil(base / 2) - 1); assert.equal(sources.length, expected, `nothing before ${Math.ceil(base / 2)} ms`);
      await tick(base - Math.ceil(base / 2) + 1); assert.equal(sources.length, ++expected, `a new stream by ${base} ms`);
    }
    // A stream that opens ends the backoff: the next refusal starts again at 0.5-1 s.
    sources.at(-1)!.emit('open', 1);
    await settle();
    sources.at(-1)!.emit('error', 2);
    await tick(499); assert.equal(sources.length, expected);
    await tick(501); assert.equal(sources.length, ++expected);
    // The new stream is wired like the first: a change frame makes the tab fetch.
    const before = sources.length;
    sources.at(-1)!.emit('error', 2);
    await sync.signOut();
    await tick(120_000);
    assert.equal(sources.length, before, 'after sign-out nothing reopens the stream');
  });
});

test('a reopened stream delivers change frames', async () => {
  await withTab(async ({ server, sources, tick }) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    sources[0].emit('error', 2);
    await tick(1000);
    assert.equal(sources.length, 2);
    const before = server.gets;
    server.revision++;
    sources[1].emit('change', 1, { revision: server.revision, locks: server.lockRevision });
    await settle();
    assert.ok(server.gets > before, 'the change frame on the new stream triggers a fetch');
    assert.equal(sources[0].readyState, 2, 'the refused stream is closed');
  });
});
