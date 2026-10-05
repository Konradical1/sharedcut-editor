import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameLineServer } from './index.ts';
import { createHostGuard, GIB, type HostGuard } from './hostGuard.ts';
import type { HealthSummary, PlaybackReport } from '../src/services/playbackReportTypes.ts';

// How server/index.ts wires the host guard, the playback reports and the lock epoch. No ffmpeg, no Python, no real waits
// over a second; every data folder is under os.tmpdir().

type Booted = Awaited<ReturnType<typeof boot>>;

async function boot(options: { mode?: string; hostMonitor?: boolean; hostGuard?: HostGuard; clip?: boolean } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'frameline-wiring-'));
  if (options.mode) await writeFile(join(dataDir, 'host-guard.mode'), options.mode);
  const app = createFrameLineServer({ dataDir, hostMonitor: options.hostMonitor, hostGuard: options.hostGuard });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const signUp = async (name: string, email: string) => {
    const response = await fetch(`${origin}/api/auth/signup`, { method: 'POST', headers, body: JSON.stringify({ name, email, password: 'a shared wiring password' }) });
    assert.equal(response.status, 201, await response.text());
    return response.headers.get('set-cookie')!.split(';')[0];
  };
  const get = (cookie: string, path: string) => fetch(`${origin}/api${path}`, { headers: { cookie } });
  const post = (cookie: string, path: string, body: unknown, method = 'POST') => fetch(`${origin}/api${path}`, { method, headers: { ...headers, cookie }, body: JSON.stringify(body) });
  const ada = await signUp('Ada', 'ada@example.com'), bo = await signUp('Bo', 'bo@example.com');
  const start = await (await get(ada, '/state')).json();
  const adaId = start.state.currentUserId as string;
  // One static title in the first four seconds: nothing to bake, so a preview of chunk 0 is a plain render.
  const title = JSON.stringify({ runs: [{ text: 'Hi', style: { fontFamily: 'Helvetica Neue', fontSize: 96, fontWeight: 600, italic: false, underline: false, letterSpacing: 0, color: '#ffffff' } }], x: 0, y: 0, width: .5, height: .2, align: 'center', lineHeight: 1.2, opacity: 100 });
  const clips = options.clip ? [{ id: 'c1', projectId: 'p1', timelineId: 't1', trackId: 'v1', mediaId: 'frameline-title', name: 'c1', start: 0, duration: 3, sourceIn: 0, color: '#abcdef', disabled: false, properties: { textDocument: title }, effects: [] }] : [];
  const tracks = options.clip ? [{ id: 'v1', timelineId: 't1', name: 'v1', kind: 'video', number: 1, muted: false, solo: false, locked: false, hidden: false, gain: 0, pan: 0 }] : [];
  const draft = { ...start.state, projects: [{ id: 'p1', name: 'Shared cut', description: '', thumbnail: '', modifiedAt: 1, duration: 10, resolution: '1920x1080', fps: 24, shared: true, status: 'In progress', members: [] }], timelines: [{ id: 't1', projectId: 'p1', name: 'Main', duration: 10 }], tracks, clips };
  const seeded = await post(ada, '/state', { revision: start.revision, state: draft }, 'PUT');
  assert.equal(seeded.status, 200, await seeded.text());
  const presence = (cookie: string, clientId: string, health?: unknown) => post(cookie, '/presence', { projectId: 'p1', timelineId: 't1', clientId, active: true, playhead: 0, ...(health === undefined ? {} : { health }) });
  const report = async (cookie: string) => get(cookie, '/health/report');
  const cleanup = () => rm(dataDir, { recursive: true, force: true });
  return { app, dataDir, origin, ada, bo, adaId, start, get, post, presence, report, cleanup, close: async () => { await app.close(); await cleanup(); } };
}

const block = (fps = 25, extra: Partial<PlaybackReport> = {}): PlaybackReport => ({
  v: 1, build: 'abc123', at: Date.now(), windowMs: 10_000, playing: true, targetFps: 30, fps, loadingPct: 3, worstFreezeMs: 120,
  waitMs: { color: 0, decode: 50, buffer: 0, seek: 0, other: 0 }, linkMbps: null, rttMs: null, netType: null, downlinkMbps: null, saveData: false,
  cores: 8, memoryGB: 8, gpu: 'test gpu', agent: 'Test', longTaskMs: null, quality: 'Full', engine: 'canvas', source: 'live', playheadMin: 0, cachedPct: null,
  harness: false, onHost: false, ...extra,
});

async function withHealthUsers<T>(ids: string, work: () => Promise<T>): Promise<T> {
  const previous = process.env.FRAME_LINE_HEALTH_USERS;
  process.env.FRAME_LINE_HEALTH_USERS = ids;
  try { return await work(); } finally { if (previous === undefined) delete process.env.FRAME_LINE_HEALTH_USERS; else process.env.FRAME_LINE_HEALTH_USERS = previous; }
}
const summaryOf = async (booted: Booted, cookie: string) => (await (await booted.report(cookie)).json()) as HealthSummary;

test('lock changes are numbered from the server start, and every state answer carries the start stamp', async () => {
  const first = await boot();
  let firstRevision: number, firstStarted: number;
  try {
    const full = await (await first.get(first.ada, '/state')).json();
    assert.ok(Number.isSafeInteger(full.serverStartedAt) && Math.abs(Date.now() - full.serverStartedAt) < 60_000, 'a full answer is stamped');
    assert.ok(full.lockRevision >= full.serverStartedAt, 'the counter starts at the stamp, so it never falls behind a number an open tab saw before a restart');
    const before = full.lockRevision;
    assert.equal((await first.post(first.ada, '/locks', { projectId: 'p1', targetId: 't1', field: 'manipulation' })).status, 200);
    const quick = await (await first.get(first.bo, `/state?since=${full.revision + 1}`)).json();
    assert.equal(quick.serverStartedAt, full.serverStartedAt, 'a short-circuited poll carries the same stamp');
    assert.equal(quick.lockRevision - before, 1, 'each lock change still counts by one');
    firstRevision = quick.lockRevision; firstStarted = full.serverStartedAt;
  } finally { await first.close(); }
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await boot();
  try {
    const again = await (await second.get(second.ada, '/state')).json();
    assert.ok(again.serverStartedAt > firstStarted, 'a restart is a different stamp');
    assert.ok(again.lockRevision > firstRevision!, 'and a restarted server counts above every number the last one handed out');
  } finally { await second.close(); }
});

test('a browser report in presence reaches the Health page of an allowed account only; everyone else gets an unknown route', async () => {
  const booted = await boot();
  try {
    const { ada, bo, adaId, presence, report } = booted;
    assert.equal((await presence(bo, 'bo-tab', block(25))).status, 200);
    assert.equal((await presence(ada, 'ada-tab')).status, 200, 'an older client sends no health block and is unaffected');
    assert.equal((await report(ada)).status, 404, 'nobody is listed in FRAME_LINE_HEALTH_USERS yet');
    await withHealthUsers(adaId, async () => {
      const summary = await summaryOf(booted, ada);
      assert.ok(Math.abs(Date.now() - summary.generatedAt) < 5_000);
      const person = summary.people.find(item => item.name === 'Bo');
      assert.ok(person, 'Bo is listed');
      assert.equal(person.clientId, 'bo-tab');
      assert.equal(person.projectId, 'p1');
      assert.equal(person.latest?.fps, 25);
      assert.equal(person.online, true);
      const quiet = summary.people.find(item => item.name === 'Ada');
      assert.ok(quiet, 'a present browser that sent nothing is listed too');
      assert.equal(quiet.light, 'grey');
      assert.equal(quiet.latest, null);
      const refused = await report(bo);
      assert.equal(refused.status, 404);
      assert.equal((await refused.json()).error, 'API endpoint not found.', 'worded exactly like a route that does not exist');
      const unknown = await booted.get(bo, '/no-such-route');
      assert.equal(unknown.status, 404);
      assert.equal((await unknown.json()).error, 'API endpoint not found.');
    });
    assert.equal((await fetch(`${booted.origin}/api/health/report`)).status, 401, 'signed out answers as every other API route does');
  } finally { await booted.close(); }
});

test('reports are taken at most once every five seconds per browser, and a bad block is dropped without touching presence', async () => {
  const booted = await boot();
  try {
    const { ada, bo, adaId, presence } = booted;
    assert.equal((await presence(bo, 'bo-tab', block(25))).status, 200);
    assert.equal((await presence(bo, 'bo-tab', block(5))).status, 200, 'presence itself is never refused for being early');
    assert.equal((await presence(bo, 'other-tab', block(18))).status, 200, 'another browser has its own allowance');
    assert.equal((await presence(bo, 'bad-tab', { v: 1, fps: 'fast' })).status, 200, 'a block that fails validation is ignored');
    assert.equal((await presence(bo, 'junk-tab', 'not an object')).status, 200);
    await withHealthUsers(adaId, async () => {
      const people = (await summaryOf(booted, ada)).people.filter(item => item.name === 'Bo');
      const byClient = new Map(people.map(item => [item.clientId, item]));
      assert.equal(byClient.get('bo-tab')?.latest?.fps, 25, 'the second report inside five seconds was not stored');
      assert.equal(byClient.get('other-tab')?.latest?.fps, 18);
      assert.equal(byClient.get('bad-tab')?.latest ?? null, null, 'the bad block stored nothing');
      assert.equal(byClient.get('junk-tab')?.latest ?? null, null);
    });
  } finally { await booted.close(); }
});

test('the Health page reads the host through the guard: its mode comes from data/host-guard.mode', async () => {
  const observing = await boot();
  try {
    await withHealthUsers(observing.adaId, async () => {
      const { host } = await summaryOf(observing, observing.ada);
      assert.equal(host.guardMode, 'observe', 'watch only unless told otherwise');
      assert.ok(Number.isFinite(host.freeGB) && host.freeGB > 0);
      assert.ok(Math.abs(Date.now() - host.at) < 5_000, 'stamped with the wall clock, not the guard\'s monotonic one');
      assert.ok(host.queued >= 0 && host.running >= 0 && host.previewsRunning >= 0);
    });
  } finally { await observing.close(); }
  const enforcing = await boot({ mode: '﻿enforce\r\n' });
  try {
    await withHealthUsers(enforcing.adaId, async () => assert.equal((await summaryOf(enforcing, enforcing.ada)).host.guardMode, 'enforce', 'a switch file written by PowerShell 5 (BOM, CRLF) is understood'));
  } finally { await enforcing.close(); }
});

test('shutdown writes the open minute of reports to a daily file', async () => {
  const booted = await boot();
  try {
    assert.equal((await booted.presence(booted.bo, 'bo-tab', block(22))).status, 200);
    await booted.app.close();
    const folder = join(booted.dataDir, 'playback-reports');
    const files = (await readdir(folder)).filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
    assert.equal(files.length, 1);
    const rows = (await readFile(join(folder, files[0]), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].clientId, 'bo-tab');
    assert.equal(rows[0].report.fps, 22);
    assert.equal('name' in rows[0], false, 'no display name is stored, only the account id');
  } finally { await booted.cleanup(); }
});

test('the host health log starts with the monitor and records queues and live children, and is off by default', async () => {
  const quiet = await boot();
  try { assert.deepEqual(await readdir(quiet.dataDir).then(names => names.filter(name => name.startsWith('host-health'))), [], 'a plain server (every other test) writes no log and launches nothing'); }
  finally { await quiet.close(); }
  const previous = { ps: process.env.FRAME_LINE_POWERSHELL, smi: process.env.FRAME_LINE_NVIDIA_SMI };
  // Programs that fail at once stand in for PowerShell and nvidia-smi: the log must still be written with those readings empty.
  process.env.FRAME_LINE_POWERSHELL = process.execPath; process.env.FRAME_LINE_NVIDIA_SMI = process.execPath;
  const watched = await boot({ hostMonitor: true });
  try {
    const file = join(watched.dataDir, 'host-health.log');
    let text = '';
    for (let waited = 0; waited < 1_000 && !text; waited += 50) { await new Promise(resolve => setTimeout(resolve, 50)); text = await readFile(file, 'utf8').catch(() => ''); }
    const line = JSON.parse(text.split('\n')[0]);
    assert.equal(typeof line.availableGB, 'number');
    assert.equal(typeof line.children, 'number');
    assert.equal(typeof line.queues, 'object');
    assert.equal(line.pagesPerSec, null);
    assert.equal(line.gpuMemUsedGB, null);
  } finally {
    if (previous.ps === undefined) delete process.env.FRAME_LINE_POWERSHELL; else process.env.FRAME_LINE_POWERSHELL = previous.ps;
    if (previous.smi === undefined) delete process.env.FRAME_LINE_NVIDIA_SMI; else process.env.FRAME_LINE_NVIDIA_SMI = previous.smi;
    await watched.close();
  }
});

test('while the guard enforces and memory is short a preview is refused with 429 and a Retry-After, with nothing admitted or rendered', async () => {
  const guard = createHostGuard({ sample: () => ({ availableBytes: 1 * GIB, commitHeadroomBytes: null }), envMode: 'enforce', log: () => undefined });
  const booted = await boot({ hostGuard: guard, clip: true });
  try {
    const ask = () => booted.post(booted.bo, '/timeline-previews', { projectId: 'p1', timelineId: 't1', chunk: 0, width: 320, height: 180 });
    const refused = await ask();
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error, 'Preview queue busy');
    assert.equal(refused.headers.get('retry-after'), '3');
    assert.equal(guard.snapshot().running, 0, 'nothing was admitted, so nothing was scheduled');
    assert.equal((await ask()).status, 429, 'it keeps refusing; there is no queue to grow');
    assert.equal(guard.snapshot().queued, 0);
  } finally { await booted.close(); }
});

test('a preview that is running is on the guard\'s abort list, and leaves it when it ends', async () => {
  const guard = createHostGuard({ envMode: 'off', log: () => undefined });
  const listed: string[] = [], forgotten: string[] = [], register = guard.registerVictim.bind(guard);
  guard.registerVictim = (kind, abort) => { listed.push(kind); const forget = register(kind, abort); return () => { forgotten.push(kind); forget(); }; };
  // A program that cannot start makes the render fail at once: the job still runs through the queue, and no ffmpeg is launched.
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = join(tmpdir(), 'frameline-no-such-ffmpeg');
  const booted = await boot({ hostGuard: guard, clip: true });
  try {
    const ask = async () => (await (await booted.post(booted.bo, '/timeline-previews', { projectId: 'p1', timelineId: 't1', chunk: 0, width: 320, height: 180 })).json()) as { status: string };
    assert.equal((await ask()).status, 'preparing');
    let status = 'preparing';
    for (let waited = 0; waited < 1_000 && status === 'preparing'; waited += 25) { await new Promise(resolve => setTimeout(resolve, 25)); status = (await ask()).status; }
    assert.equal(status, 'failed', 'the render could not start');
    assert.deepEqual(listed, ['preview']);
    assert.deepEqual(forgotten, ['preview'], 'a finished job is no longer a victim');
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous;
    await booted.close();
  }
});
