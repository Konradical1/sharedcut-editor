import assert from 'node:assert/strict';
import test from 'node:test';
import type { PersistedState } from './index.ts';
import type { MediaAsset, Project, User } from '../state/models.ts';

test('sync preserves pending edits, resolves only conflicts, and isolates asynchronous sessions', async () => {
  const storage = new Map<string, string>();
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  const replaced: string[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { location: { pathname: '/', replace: (path: string) => replaced.push(path) } }) });
  const { useEditorStore } = await import('../state/store.ts');
  const { connection } = await import('./api.ts');
  const { connectSession, flushChanges, refreshState, resolveSyncConflict, signOut } = await import('./sync.ts');
  const user = (id: string): User => ({ id, name: id, email: `${id}@test.local`, color: '#abcdef', initials: id[0] });
  const state = (id: string): PersistedState => ({ projects: [{ id: `${id}-project`, name: `${id} private project`, description: '', members: [{ userId: id, role: 'Owner' }] } as Project], media: [], timelines: [], tracks: [], clips: [], nodes: [], comments: [], operations: [], snapshots: [], renderJobs: [], scripts: [], scriptBlocks: [], shots: [], boardItems: [], users: [user(id)], currentUserId: id, settings: { uiScale: '100%', timelineDensity: 'comfortable', reducedMotion: false } });
  let currentUser: User | null = user('alice'), remote = state('alice'), revision = 1;
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  const envelope = () => ({ revision, lockRevision: 0, state: structuredClone(remote), presence: [], locks: [] });
  const gets: (() => Promise<Response>)[] = [];
  let holdPut: ((sent: PersistedState) => Promise<Response>) | undefined;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url), 'http://test.local'); const route = target.pathname;
    if (route === '/api/auth/me') return json({ user: currentUser });
    if (route === '/api/auth/logout') { currentUser = null; return json({ ok: true }); }
    assert.equal(route, '/api/state');
    if (!options.method || options.method === 'GET') {
      if (gets.length) return gets.shift()!();
      // A caller that already holds this revision gets the ephemeral half only, as the server does.
      if (target.searchParams.get('since') === String(revision)) return json({ revision, lockRevision: 0, presence: [], locks: [] });
      return json(envelope());
    }
    const request = JSON.parse(String(options.body));
    if (holdPut) { const handler = holdPut; holdPut = undefined; return handler(request.state); }
    if (request.revision !== revision) return json(envelope(), 409);
    remote = request.state; revision++; return json(envelope());
  };
  const localEdit = (patch: Partial<Project>) => useEditorStore.setState({ projects: useEditorStore.getState().projects.map(project => ({ ...project, ...patch })) });
  const remoteEdit = (patch: Partial<Project>) => { remote.projects[0] = { ...remote.projects[0], ...patch }; revision++; };
  const deferred = () => { let resolve!: (response: Response) => void; const promise = new Promise<Response>(yes => { resolve = yes; }); return { promise, resolve }; };
  try {
    const savedOperation = { id: 'published-drag', projectId: 'alice-project', userId: 'alice', timestamp: 1, targetId: 'clip', type: 'PropertyChanged' as const, description: 'Drag x', oldState: [{collection:'clips',id:'clip',value:{'properties.x':0}}], newState: [{collection:'clips',id:'clip',value:{'properties.x':10}}] };
    remote.operations = [structuredClone(savedOperation)];
    const legacyDraft = structuredClone(remote);legacyDraft.operations[0].timestamp=2;legacyDraft.operations[0].newState=[{collection:'clips',id:'clip',value:{'properties.x':20}}];
    storage.set('frameline.unsaved.alice',JSON.stringify({base:remote,draft:legacyDraft}));
    await connectSession();
    assert.equal(remote.operations.length,2,'A legacy rewritten operation becomes a new recovery entry.');
    assert.deepEqual(remote.operations.find(op=>op.id===savedOperation.id),savedOperation);
    assert.deepEqual(remote.operations[0].oldState,savedOperation.newState);
    assert.deepEqual(remote.operations[0].newState,legacyDraft.operations[0].newState);
    assert.equal(useEditorStore.getState().session, 'ready');

    remote.media = [{ id: 'upload', projectId: 'alice-project', status: 'uploading', progress: 0, thumbnail: '' } as MediaAsset]; revision++;
    await refreshState();
    const progressReply = deferred(), completeReply = deferred();
    remote.media = [{ ...remote.media[0], progress: 45, thumbnail: '/api/media/upload/files/thumbnail.jpg' }]; revision++;
    const progressEnvelope = envelope(); gets.push(() => progressReply.promise);
    const progressRefresh = refreshState();
    remote.media = [{ ...remote.media[0], status: 'ready', progress: 100 }]; revision++;
    gets.push(() => completeReply.promise); const completeRefresh = refreshState();
    progressReply.resolve(await json(progressEnvelope));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(useEditorStore.getState().media[0].progress, 45, 'The first response applies before the queued refresh.');
    completeReply.resolve(await json(envelope())); await Promise.all([progressRefresh, completeRefresh]);
    assert.equal(useEditorStore.getState().media[0].status, 'ready', 'Completion appears without reloading the editor.');

    const imported = { id: 'sound', projectId: 'alice-project', status: 'ready' } as MediaAsset;
    remote.media.unshift(imported); revision++;
    connection.receiveMedia(imported, revision);
    assert.deepEqual(useEditorStore.getState().media, remote.media, 'Imported media appears immediately in server order.');
    connection.receiveMedia(imported, revision);
    assert.deepEqual(useEditorStore.getState().media, remote.media, 'Reusing a sound preserves authoritative media order.');

    // A rejected recovery save must not masquerade as a failed connection or hide the draft.
    localEdit({ description: 'Recovered edit rejected by an older server' });
    holdPut = () => json({ error: 'Invalid animation property.' }, 400);
    await connectSession();
    assert.equal(useEditorStore.getState().session, 'ready');
    assert.equal(useEditorStore.getState().serverOnline, true);
    assert.equal(useEditorStore.getState().saveStatus, 'Save failed');
    assert.equal(useEditorStore.getState().projects[0].description, 'Recovered edit rejected by an older server');
    assert.ok(storage.has('frameline.unsaved.alice'));
    // A recovery draft holds only what the server lacks; saved history would otherwise double the payload.
    const cached = JSON.parse(storage.get('frameline.unsaved.alice')!);
    assert.deepEqual(cached.draft.operations, [], 'Saved operations must not be copied into local recovery storage.');
    assert.deepEqual(cached.base.operations, []);
    assert.equal(cached.draft.projects[0].description, 'Recovered edit rejected by an older server', 'The unsaved edit itself is still cached.');
    assert.ok(useEditorStore.getState().notifications.some(n => n.title === 'Invalid animation property.'));
    await flushChanges();
    assert.equal(remote.projects[0].description, 'Recovered edit rejected by an older server');
    assert.equal(storage.has('frameline.unsaved.alice'), false);

    const first = deferred(), oldEnvelope = envelope(); gets.push(() => first.promise);
    const slowRefresh = refreshState();
    remoteEdit({ name: 'Newer remote name' }); const queuedRefresh = refreshState();
    first.resolve(await json(oldEnvelope)); await Promise.all([slowRefresh, queuedRefresh]);
    assert.equal(useEditorStore.getState().projects[0].name, 'Newer remote name', 'A late GET cannot regress the current revision.');

    const beforeSave = deferred(), beforeSaveEnvelope = envelope(); gets.push(() => beforeSave.promise);
    const lateRefresh = refreshState(); localEdit({ name: 'Saved while GET was pending' }); await flushChanges();
    beforeSave.resolve(await json(beforeSaveEnvelope)); await lateRefresh;
    assert.equal(useEditorStore.getState().projects[0].name, 'Saved while GET was pending', 'A GET crossing a completed PUT must not resurrect the old state.');

    const put = deferred(); let submitted!: PersistedState;
    holdPut = sent => { submitted = sent; return put.promise; };
    localEdit({ description: 'First edit' }); const saving = flushChanges();
    localEdit({ description: 'Edited while saving' }); remote = structuredClone(submitted); revision++; put.resolve(await json(envelope())); await saving;
    assert.equal(remote.projects[0].description, 'Edited while saving', 'Edits made during PUT remain pending and are saved next.');

    localEdit({ name: 'My competing name', description: 'Independent local description' }); remoteEdit({ name: 'Their competing name' }); await refreshState();
    assert.ok(useEditorStore.getState().syncConflict.includes('/projects/alice-project/name'));
    remote.media = [{ ...remote.media[0], progress: 72, status: 'processing' }]; revision++;
    await refreshState();
    assert.equal(useEditorStore.getState().media[0].progress, 72, 'Media progress continues while unrelated edits are conflicted.');
    assert.equal(useEditorStore.getState().projects[0].name, 'My competing name', 'Progress updates must not overwrite the pending edit.');
    resolveSyncConflict(false); await flushChanges();
    assert.equal(remote.projects[0].name, 'Their competing name');
    assert.equal(remote.projects[0].description, 'Independent local description', 'Choosing the server conflict value must preserve unrelated unsaved edits.');

    localEdit({ name: 'Recovered competing name' }); remoteEdit({ name: 'Latest server name' }); await refreshState();
    await connectSession();
    assert.ok(useEditorStore.getState().syncConflict.length > 0, 'Recovery retains the original conflict baseline instead of silently overwriting the server.');
    assert.equal(remote.projects[0].name, 'Latest server name');
    resolveSyncConflict(true); await flushChanges(); assert.equal(remote.projects[0].name, 'Recovered competing name');

    const oldAccount = deferred(), aliceEnvelope = envelope(); gets.push(() => oldAccount.promise); const aliceRefresh = refreshState();
    await signOut();
    assert.deepEqual(useEditorStore.getState().projects, []); assert.equal(useEditorStore.getState().currentUserId, '');
    currentUser = user('bob'); remote = state('bob'); revision = 1; await connectSession();
    oldAccount.resolve(await json(aliceEnvelope)); await aliceRefresh;
    assert.equal(useEditorStore.getState().currentUserId, 'bob'); assert.equal(useEditorStore.getState().projects[0].id, 'bob-project', 'An old account response cannot leak into the next account.');

    localEdit({ name: 'Bob unsaved offline edit' }); gets.push(() => json({ error: 'Session expired' }, 401)); await refreshState();
    assert.equal(connection.enabled, false); assert.equal(useEditorStore.getState().session, 'signedOut'); assert.deepEqual(useEditorStore.getState().projects, []);
    assert.equal(JSON.parse(storage.get('frameline.unsaved.bob')!).draft.projects[0].name, 'Bob unsaved offline edit');

    currentUser = user('alice'); remote = state('alice'); revision = 1; await connectSession();
    const oldPut = deferred(); let aliceSubmitted!: PersistedState; holdPut = sent => { aliceSubmitted = sent; return oldPut.promise; };
    localEdit({ description: 'Alice in flight' }); const aliceSave = flushChanges();
    currentUser = user('carol'); remote = state('carol'); revision = 1; await connectSession();
    oldPut.resolve(await json({ revision: 999, state: aliceSubmitted })); await aliceSave;
    assert.equal(useEditorStore.getState().currentUserId, 'carol', 'Late PUT acknowledgements also belong to the original session.');
    assert.equal(JSON.parse(storage.get('frameline.unsaved.alice')!).draft.projects[0].description, 'Alice in flight');
    await signOut();

    // A guest opening / goes to sharedcut.com/importer; it never asks for /api/state (the server would refuse it anyway).
    currentUser = { ...user('maya'), guest: true }; gets.push(() => { throw new Error('a guest must not load the workspace'); });
    await connectSession();
    assert.deepEqual(replaced, ['/importer']); assert.equal(useEditorStore.getState().session, 'loading'); assert.equal(connection.enabled, false);
    gets.length = 0;
  } finally {
    currentUser = null;
    await connectSession();
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('a change arriving mid-save is replayed, bulk edits retry quietly, and a locked item is surrendered', async () => {
  const storage = new Map<string, string>();
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { location: { pathname: '/' } }) });
  const { useEditorStore } = await import('../state/store.ts');
  const { connectSession, flushChanges, refreshState, signOut } = await import('./sync.ts');
  const user = (id: string): User => ({ id, name: id, email: `${id}@test.local`, color: '#abcdef', initials: id[0] });
  const base = (): PersistedState => ({ projects: [{ id: 'p', name: 'Server name', description: '', members: [{ userId: 'alice', role: 'Owner' }] } as Project], media: [], timelines: [], tracks: [], clips: [], nodes: [], comments: [], operations: [], snapshots: [], renderJobs: [], scripts: [], scriptBlocks: [], shots: [], boardItems: [], users: [user('alice')], currentUserId: 'alice', settings: { uiScale: '100%', timelineDensity: 'comfortable', reducedMotion: false } });
  let remote = base(), revision = 1, locks: unknown[] = [];
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  const envelope = () => ({ revision, lockRevision: 0, state: structuredClone(remote), presence: [], locks });
  let onPut: ((sent: PersistedState) => Promise<Response> | undefined) | undefined;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url), 'http://test.local');
    if (target.pathname === '/api/auth/me') return json({ user: user('alice') });
    if (target.pathname === '/api/auth/logout') return json({ ok: true });
    if (!options.method || options.method === 'GET') {
      if (target.searchParams.get('since') === String(revision)) return json({ revision, lockRevision: 0, presence: [], locks });
      return json(envelope());
    }
    const sent = JSON.parse(String(options.body)).state as PersistedState;
    const held = onPut?.(sent); if (held) return held;
    if (JSON.parse(String(options.body)).revision !== revision) return json(envelope(), 409);
    remote = sent; revision++; return json(envelope());
  };
  const settle = async (ready: () => boolean, budget = 200) => { for (let i = 0; i < budget && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  const rename = (name: string) => useEditorStore.setState({ projects: useEditorStore.getState().projects.map(project => ({ ...project, name })) });
  try {
    await connectSession();

    // A change that lands while a save is in flight used to be dropped until some later poll.
    let release!: (response: Response) => void; let acked!: ReturnType<typeof envelope>;
    // The acknowledgement is captured before the collaborator edits, so only a replayed refresh can
    // deliver their change — exactly the frame the old code discarded.
    onPut = sent => { const wait = new Promise<Response>(resolve => { release = resolve; }); onPut = undefined; remote = sent; revision++; acked = envelope(); return wait; };
    rename('Alice edit'); const saving = flushChanges();
    await settle(() => !!release);
    remote = { ...structuredClone(remote), projects: [{ ...remote.projects[0], description: 'Arrived during the save' }] }; revision++;
    await refreshState();                       // the event a collaborator's edit would trigger
    assert.notEqual(acked.state.projects[0].description, 'Arrived during the save');
    release(await json(acked)); await saving;
    // Well inside the 1s fallback poll: the replay must be prompt, not eventually-rescued.
    await settle(() => useEditorStore.getState().projects[0].description === 'Arrived during the save', 20);
    assert.equal(useEditorStore.getState().projects[0].description, 'Arrived during the save', 'A change seen mid-save must be replayed at once, not left for the next poll.');

    // Editing faster than the save loop is normal work, not an error to toast about.
    useEditorStore.setState({ notifications: [] });
    let bursts = 0;
    onPut = () => { if (++bursts < 8) rename(`Burst ${bursts}`); return undefined; };
    rename('Burst 0');
    await assert.doesNotReject(flushChanges(), 'Outrunning the save loop must not surface as an error.');
    assert.deepEqual(useEditorStore.getState().notifications, [], 'A bulk edit that simply outran the save must stay silent.');
    onPut = undefined; await flushChanges();

    // A collaborator's lock costs you that item, not the rest of your unsaved work.
    locks = [{ id: 'l', projectId: 'p', targetId: 'p', field: '*', userId: 'bob', expiresAt: Date.now() + 8_000 }];
    await refreshState();
    assert.equal(useEditorStore.getState().locks.length, 1);
    const server = useEditorStore.getState().projects[0].name;
    let refusals = 0;
    onPut = () => (refusals++ ? undefined : json({ error: 'A collaborator is editing this item.' }, 423));
    rename('Name Bo is holding');
    useEditorStore.setState({ settings: { ...useEditorStore.getState().settings, timelineDensity: 'compact' } });
    await flushChanges();
    assert.equal(useEditorStore.getState().projects[0].name, server, 'The locked item reverts to the collaborator’s copy.');
    assert.equal(useEditorStore.getState().settings.timelineDensity, 'compact', 'Unrelated pending edits survive a lock rejection.');
    assert.equal(useEditorStore.getState().saveStatus, 'Saved');
  } finally {
    onPut = undefined;
    await signOut().catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('a drag preview larger than the server accepts is trimmed, a big drag is paced, and a rejected preview does not read as offline', async () => {
  const storage = new Map<string, string>();
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } });
  const location = { pathname: '/' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { location }) });
  const { useEditorStore } = await import('../state/store.ts');
  const { connectSession, signOut } = await import('./sync.ts');
  const alice: User = { id: 'alice', name: 'alice', email: 'alice@test.local', color: '#abcdef', initials: 'a' };
  const remote: PersistedState = { projects: [{ id: 'p', name: 'P', description: '', members: [{ userId: 'alice', role: 'Owner' }] } as Project], media: [], timelines: [], tracks: [], clips: [], nodes: [], comments: [], operations: [], snapshots: [], renderJobs: [], scripts: [], scriptBlocks: [], shots: [], boardItems: [], users: [alice], currentUserId: 'alice', settings: { uiScale: '100%', timelineDensity: 'comfortable', reducedMotion: false } };
  const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  const sent: { preview: { clips?: { id: string; start: number }[]; tracks?: { id: string }[] } | null }[] = [];
  let answer: 'ok' | 'rejected' | 'unreachable' = 'ok';
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url), 'http://test.local');
    if (target.pathname === '/api/auth/me') return json({ user: alice });
    if (target.pathname === '/api/auth/logout') return json({ ok: true });
    if (target.pathname === '/api/presence') {
      const body = JSON.parse(String(options.body)); sent.push(body);
      if (answer === 'unreachable') throw new TypeError('fetch failed');
      // The real server's rules: more than 1000 items is a 400, a collaborator's held item is a 423.
      if (answer === 'rejected' || body.preview?.clips?.length > 1000 || body.preview?.tracks?.length > 1000) return json({ error: 'Invalid drag preview.' }, answer === 'rejected' ? 423 : 400);
      return json({ presence: [], serverTime: Date.now() });
    }
    return json({ revision: 1, lockRevision: 0, state: structuredClone(remote), presence: [], locks: [] });
  };
  const settle = async (ready: () => boolean, budget = 400) => { for (let i = 0; i < budget && !ready(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  const clips = (count: number, shift = 0) => Array.from({ length: count }, (_, i) => ({ id: `c${i}`, start: i + shift, duration: 1, trackId: 't' }));
  const publish = async (preview: { clips?: ReturnType<typeof clips>; tracks?: { id: string; height: number }[] }) => {
    const before = sent.length; useEditorStore.setState({ dragPreview: preview });
    await settle(() => sent.some((body, i) => i >= before && body.preview));
    return sent.slice(before).filter(body => body.preview).at(-1)!.preview!;
  };
  try {
    await connectSession();
    location.pathname = '/project/p'; useEditorStore.setState({ projectId: 'p', timelineId: 't' });

    const trimmed = await publish({ clips: clips(1500) });
    assert.equal(trimmed.clips!.length, 1000, 'A big forward drag shows collaborators a partial ghost instead of a rejected request.');
    assert.deepEqual([trimmed.clips![0].id, trimmed.clips![999].id], ['c0', 'c999']);
    assert.equal(useEditorStore.getState().serverOnline, true, 'The cap keeps the app online mid-drag.');
    assert.equal(useEditorStore.getState().dragPreview!.clips!.length, 1500, 'Only the copy that is sent is trimmed; the local drag keeps every clip.');
    assert.equal((await publish({ clips: clips(3, 5) })).clips!.length, 3, 'A preview under the limit is sent whole.');
    const tracks = await publish({ tracks: Array.from({ length: 1200 }, (_, i) => ({ id: `t${i}`, height: 60 })) });
    assert.equal(tracks.tracks!.length, 1000);

    // A preview of more than 100 clips is a big request, so between a drag's first preview and its end it goes out about 4 times a second, not at every 50 ms tick.
    const bodiesWith = (from: number) => sent.slice(from).filter(body => body.preview).length;
    const lastIs = (preview: null | object) => () => (sent.at(-1)!.preview === null) === (preview === null);
    const timed = async (action: () => void, ready: () => boolean) => { const at = Date.now(); action(); await settle(ready); return Date.now() - at; };
    const ended = await timed(() => useEditorStore.setState({ dragPreview: null }), lastIs(null));
    assert.ok(ended < 180, `A drag ending is published at once (${ended} ms).`);
    let mark = sent.length;
    const first = await timed(() => useEditorStore.setState({ dragPreview: { clips: clips(150) } }), () => bodiesWith(mark) > 0);
    assert.ok(first < 180, `The first preview of a drag is published at once (${first} ms), just after the last request.`);
    for (let step = 1; step <= 40; step++) { useEditorStore.setState({ dragPreview: { clips: clips(150, step) } }); await new Promise(resolve => setTimeout(resolve, 25)); }
    const paced = bodiesWith(mark);
    assert.ok(paced >= 3 && paced <= 6, `A second of a 150-clip drag is a handful of requests, not one per tick (${paced}).`);
    assert.equal(sent.at(-1)!.preview!.clips![0].id, 'c0');
    await settle(() => bodiesWith(mark) > paced);       // the position the pointer stopped at is still published, a quarter second later at most
    assert.equal(sent.at(-1)!.preview!.clips![0].start, 40, 'The last position of the drag gets out.');
    useEditorStore.setState({ dragPreview: { clips: clips(150, 99) } });
    const stop = await timed(() => useEditorStore.setState({ dragPreview: null }), lastIs(null));
    assert.ok(stop < 180, `The end of a drag cuts the wait short (${stop} ms).`);
    mark = sent.length;
    for (let step = 1; step <= 20; step++) { useEditorStore.setState({ dragPreview: { clips: clips(50, step) } }); await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.ok(bodiesWith(mark) >= 6, `A drag of 50 clips is not paced (${bodiesWith(mark)}).`);
    useEditorStore.setState({ dragPreview: null }); await settle(lastIs(null));

    // A 4xx means the server answered, so it stays online; only an unreachable server flips the indicator.
    answer = 'rejected';
    await publish({ clips: clips(4, 9) });
    assert.equal(useEditorStore.getState().serverOnline, true, 'A refused preview (423) is not an outage.');
    answer = 'unreachable'; useEditorStore.setState({ dragPreview: { clips: clips(5, 11) } });
    await settle(() => !useEditorStore.getState().serverOnline, 1000);
    assert.equal(useEditorStore.getState().serverOnline, false, 'A request that never reaches the server still reads as offline.');
  } finally {
    useEditorStore.setState({ dragPreview: null });
    await signOut().catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});
