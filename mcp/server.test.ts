// The MCP against a real SharedCut server on a temporary data folder: protocol, edits, refusals, rollback,
// a collaborator saving in between, undo, and the tool list's size (it is loaded into every conversation).
import './env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFrameLineServer } from '../server/index.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'sharedcut-mcp-'));
const app = createFrameLineServer({ dataDir });
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const signup = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'MCP Editor', email: 'mcp@example.com', password: 'mcp test password' }) });
const cookie = signup.headers.get('set-cookie')!.split(';')[0];
process.env.FRAME_LINE_URL = url;
process.env.FRAME_LINE_COOKIE = cookie;
const { answer } = await import('./server.ts');

test.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await answer({ method: 'tools/call', params: { name, arguments: args } }) as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: result.content.map(c => c.text).join('\n'), error: !!result.isError };
}
const ok = async (name: string, args: Record<string, unknown> = {}) => { const r = await tool(name, args); assert.equal(r.error, false, r.text); return r.text; };
const server = async () => (await (await fetch(`${url}/api/state`, { headers: { cookie } })).json()) as { revision: number; state: any };
const handleOf = (id: string) => '@' + /[0-9a-f]{8}-/.exec(id)![0].slice(0, 8);

test('handshake and a tool list small enough to load into every conversation', async () => {
  const init = await answer({ method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }) as any;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.equal(init.serverInfo.name, 'sharedcut');
  const { tools } = await answer({ method: 'tools/list' }) as { tools: { name: string; description: string }[] };
  assert.deepEqual(tools.map(t => t.name), ['projects', 'timeline', 'media', 'get', 'act', 'job', 'frame', 'help', 'api']);
  // ponytail: a budget, not a spec. Raise it deliberately if a tool genuinely needs more words.
  assert.ok(JSON.stringify(tools).length < 6500, `tool list grew to ${JSON.stringify(tools).length} chars`);
  await assert.rejects(answer({ method: 'nope' }), /Method not found/);
});

test('edits save as one batch, show as compact changes and land on the server', async () => {
  assert.match(await ok('projects'), /No projects/);
  assert.match(await ok('act', { do: [['createProject', { name: 'MCP Test', description: '', shared: false }]] }), /\+ project @\w+ "MCP Test"/);
  assert.match(await ok('timeline'), /V1 "Main picture"/);
  const added = await ok('act', { at: 2, do: [['addTitle', 3], ['addMarker', { name: 'Intro' }]] });
  assert.match(added, /\+ clip V\d @[0-9a-f]{8} 2–7 TITLE/);
  assert.match(added, /addMarker → @[0-9a-f]{8}/);
  const { state } = await server();
  assert.equal(state.clips.length, 1);
  assert.equal(state.timelines[0].markers[0].name, 'Intro');
});

test('a refused step rolls the whole batch back and says why', async () => {
  const before = await server(), title = before.state.clips[0], track = before.state.tracks.find((t: any) => t.id === title.trackId);
  const refused = await tool('act', { do: [['moveClip', handleOf(title.id), 9], ['updateTrack', handleOf(track.id), { locked: true }], ['moveClip', handleOf(title.id), 12]] });
  assert.equal(refused.error, true);
  assert.match(refused.text, /Step 3 \(moveClip\) was refused: Unlock the track/);
  const after = await server();
  assert.equal(after.state.clips[0].start, title.start, 'the first move must not have been saved');
  assert.equal(after.state.tracks.find((t: any) => t.id === track.id).locked, false);
  assert.match((await tool('act', { do: [['splitClip', '@ffffffff']] })).text, /Nothing has the id @ffffffff/);
  assert.match((await tool('act', { do: [['notAnAction']] })).text, /no action "notAnAction"/);
  // Free text that only looks like a mention is text, not an id.
  assert.match(await ok('act', { at: 3, do: [['addMarker', { name: '@konrad' }]] }), /addMarker → @/);
  assert.ok((await server()).state.timelines[0].markers.some((m: any) => m.name === '@konrad'));
  assert.match((await tool('act', { do: [['tick', 1]] })).text, /UI plumbing/);
});

test('a collaborator saving in between is merged, and undo takes back only our edit', async () => {
  const { revision, state } = await server(), title = state.clips[0];
  // Someone else renames the timeline through the browser's own save path.
  const timeline = { ...state.timelines[0], name: 'Edited elsewhere' };
  const saved = await fetch(`${url}/api/state`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ revision, delta: { timelines: { upsert: [timeline], remove: [] } } }) });
  assert.equal(saved.status, 200, await saved.text());
  assert.match(await ok('act', { do: [['moveClip', handleOf(title.id), 20]] }), /start 2→20/);
  let now = (await server()).state;
  assert.equal(now.timelines[0].name, 'Edited elsewhere');
  assert.equal(now.clips[0].start, 20);
  assert.match(await ok('act', { do: [['undo']] }), /start 20→2/);
  now = (await server()).state;
  assert.equal(now.clips[0].start, 2);
  assert.equal(now.timelines[0].name, 'Edited elsewhere');
});

test('get, help and the api escape hatch', async () => {
  const { state } = await server(), title = state.clips[0];
  assert.match(await ok('get', { id: handleOf(title.id), path: 'properties.textDocument' }), /"runs":\[/);
  assert.match(await ok('help'), /topics: actions/);
  assert.match(await ok('help', { topic: 'actions', filter: 'splitClip' }), /splitClip\(id:string\)/);
  assert.match(await ok('help', { topic: 'effects', filter: 'grain' }), /Film grain/);
  assert.match(await ok('api', { path: '/api/health' }), /"status"/);
  assert.match((await tool('api', { method: 'POST', path: '/api/auth/logout' })).text, /off limits/);
});

test('a step that saved before a later refusal is reported as kept, not "nothing was saved"', async () => {
  const clips = (await server()).state.clips.length;
  const refused = await tool('act', { at: 8, do: [['addTitle', 0], ['saveTransitionPreset', 'no-such-clip', 'in']] });
  assert.equal(refused.error, true);
  assert.match(refused.text, /Already saved by earlier steps, and kept:[\s\S]*\+ clip V\d @[0-9a-f]{8} 8–13 TITLE/);
  assert.equal((await server()).state.clips.length, clips + 1, 'the title the preset step saved stays');
});

test('a timeline handle from another project opens that project first', async () => {
  await ok('act', { do: [['createProject', { name: 'Second', description: '', shared: false }]] });
  const { state } = await server(), first = state.timelines.find((t: any) => state.projects.find((p: any) => p.id === t.projectId)?.name === 'MCP Test');
  const marked = await ok('act', { timeline: handleOf(first.id) + '-main-timeline', at: 1, do: [['addMarker', { name: 'for the first project' }]] });
  assert.match(marked, new RegExp(`~ timeline ${handleOf(first.id)}-main-timeline markers`));
});
