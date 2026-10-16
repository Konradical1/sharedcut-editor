// Plan jobs against a real SharedCut server on a temporary data folder, so every save passes the server's checks:
// a script written with act and read back with handles, a shot under its scene, the .docx/.fountain exports, a
// Fountain import into a new script and the mood board.
import '../env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFrameLineServer } from '../../server/index.ts';

const dataDir = await mkdtemp(join(tmpdir(), 'sharedcut-mcp-plan-')), out = join(dataDir, 'out');
const app = createFrameLineServer({ dataDir: join(dataDir, 'data') });
await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
const signup = await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Writer', email: 'plan@example.com', password: 'plan test password' }) });
process.env.FRAME_LINE_URL = url;
process.env.FRAME_LINE_COOKIE = signup.headers.get('set-cookie')!.split(';')[0];
const { answer } = await import('../server.ts');
const { useEditorStore: store } = await import('../../src/state/store.ts');
const { mediaView } = await import('../views.ts');

test.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });

async function tool(name: string, args: Record<string, unknown> = {}) {
  const result = await answer({ method: 'tools/call', params: { name, arguments: args } }) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map(c => c.text).join('\n'), error: !!result.isError };
}
const ok = async (name: string, args: Record<string, unknown> = {}) => { const r = await tool(name, args); assert.equal(r.error, false, r.text); return r.text; };
const job = (kind: string, params: Record<string, unknown> = {}) => ok('job', { kind, params });
const handleOf = (text: string, pattern: RegExp) => { const m = pattern.exec(text); assert.ok(m, `${pattern} in:\n${text}`); return m[1]; };
const saved = async () => (await (await fetch(`${url}/api/state`, { headers: { cookie: process.env.FRAME_LINE_COOKIE! } })).json()).state;

test('a script written with act reads back with handles, takes a shot and exports', async () => {
  await ok('act', { do: [['createProject', { name: 'Plan Test', description: '', shared: false }]] });
  assert.match(await job('plan'), /No script yet/);
  const script = handleOf(await ok('act', { do: [['addScript', 'The Tent']] }), /addScript → (@\w+)/);
  const starter = handleOf(await job('plan'), /\n(@\w+) SCENE 1 ""/);
  const added = await ok('act', { do: [['updateScriptBlock', starter, { text: 'INT. TENT - DAY' }], ['addScriptBlocks', script, [{ kind: 'action', text: 'Maya wakes.' }, { kind: 'character', text: 'MAYA' }, { kind: 'dialogue', text: 'Wake up.' }]]] });
  assert.match(added, /\+ script line @\w+ CHARACTER "MAYA"/);
  const view = await job('plan', { view: 'script', script });
  assert.match(view, new RegExp(`^${script} "The Tent" screenplay · 4 lines · ~1 page\n${starter} SCENE 1 "INT. TENT - DAY"\n@\\w+ ACTION "Maya wakes."\n@\\w+ CHARACTER "MAYA"\n@\\w+ DIALOGUE "Wake up."$`));
  const line = handleOf(view, /(@\w+) DIALOGUE/);
  assert.match(await ok('act', { do: [['updateScriptBlock', line, { text: 'Get up.' }]] }), new RegExp(`~ script line ${line} text "Wake up."→"Get up."`));
  assert.match(await job('plan', { scene: 2 }), /scene 2 \(none\)$/);

  const shot = handleOf(await ok('act', { do: [['addShot', { sceneId: starter, text: 'Maya wakes', size: 'WS', movement: 'Dolly' }]] }), /addShot → (@\w+)/);
  assert.match(await job('plan', { view: 'shots' }), new RegExp(`^1 shot\n1\\. INT\\. TENT - DAY ${starter}\n  ${shot} 1A WS Dolly "Maya wakes"$`));
  assert.match(await ok('act', { do: [['updateShot', shot, { done: true, sceneId: null }]] }), /~ shot @\w+ (?=.*done ∅→true)(?=.*sceneId)/);
  assert.match(await job('plan', { view: 'shots' }), new RegExp(`1 done\n1\\. INT\\. TENT - DAY ${starter} \\(no shots\\)\nNo scene\n  ${shot} 1A WS Dolly "Maya wakes" · done$`));

  assert.match(await job('script-export', { path: `${out}/` }), new RegExp(`Wrote ${script} "The Tent" \\(4 lines, ~1 page\\) to .*The Tent\\.docx$`));
  assert.equal((await readFile(join(out, 'The Tent.docx'))).subarray(0, 2).toString(), 'PK');
  await job('script-export', { path: join(out, 'tent.fountain') });
  const fountain = await readFile(join(out, 'tent.fountain'), 'utf8');
  assert.match(fountain, /INT\. TENT - DAY/);
  assert.match(fountain, /MAYA\nGet up\./);
  assert.match(fountain, /Author: Writer/);
  assert.match((await tool('job', { kind: 'script-export', params: { path: out, format: 'pdf' } })).text, /format is docx, fountain or html/);
  const state = await saved();
  assert.equal(state.scriptBlocks.length, 4, 'the lines reached the server');
  assert.equal(state.shots[0].done, true);
});

test('script-import makes a new script from Fountain text, or appends to one', async () => {
  const text = 'Title: Night Walk\nCredit: Written by\n\nEXT. FIELD - NIGHT\n\nWind in the grass.\n\nMAYA\n(quietly)\nHello?\n\nCUT TO:\n';
  const reply = await job('script-import', { text });
  assert.match(reply, /^(@\w+) "Night Walk" · new script, 6 lines \(1 scene, 1 action, 1 character, 1 parenthetical, 1 dialogue, 1 transition\)$/);
  const s = store.getState(), script = s.scripts.find(x => x.name === 'Night Walk')!;
  assert.equal(script.credit, 'Written by');
  const lines = s.scriptBlocks.filter(b => b.scriptId === script.id).sort((a, b) => a.order - b.order);
  assert.deepEqual(lines.map(b => b.kind), ['scene', 'action', 'character', 'parenthetical', 'dialogue', 'transition'], 'the empty starter heading is gone');
  assert.match((await tool('job', { kind: 'plan' })).text, /^2 scripts; job plan\{script:@handle\} shows one:/);
  assert.match((await tool('job', { kind: 'script-export', params: { path: out } })).text, /has 2 scripts; pass script:@handle/);
  const handle = /^(@\w+)/.exec(reply)![1];
  // A line that reads like a handle stays text.
  assert.match(await job('script-import', { text: 'INT. BARN - DAWN\n\n~@deadbeef', script: handle }), /· added 2 lines \(1 scene, 1 lyric\)$/);
  const tail = store.getState().scriptBlocks.filter(b => b.scriptId === script.id).sort((a, b) => a.order - b.order).slice(-2);
  assert.deepEqual(tail.map(b => [b.kind, b.text]), [['scene', 'INT. BARN - DAWN'], ['lyric', '@deadbeef']]);
  assert.match((await tool('job', { kind: 'script-import', params: { text: '\n\n' } })).text, /No script text found/);
  // A .docx (a zip) or a PDF is bytes, not text: refused, nothing saved.
  const before = store.getState().scripts.length;
  for (const bytes of [Buffer.from(await job('script-export', { path: join(out, 'refuse.docx'), script: handle }).then(() => readFile(join(out, 'refuse.docx')))), Buffer.from('%PDF-1.7\n1 0 obj')]) {
    const path = join(out, `binary-${bytes[0]}.bin`); await writeFile(path, bytes);
    assert.match((await tool('job', { kind: 'script-import', params: { path } })).text, /not a Fountain or plain-text file/);
  }
  assert.equal(store.getState().scripts.length, before);
});

test('the Fountain author survives import and prints instead of whoever exports', async () => {
  const id = /^(@\w+)/.exec(await job('script-import', { text: 'Title: Lena\'s Film\nAuthor: Lena Weber\n\nINT. ROOM - DAY\n\nShe waits.\n' }))![1];
  assert.equal(store.getState().scripts.find(x => x.name === "Lena's Film")!.author, 'Lena Weber');
  await job('script-export', { path: join(out, 'lena.fountain'), script: id });
  assert.match(await readFile(join(out, 'lena.fountain'), 'utf8'), /^Title: Lena's Film\nAuthor: Lena Weber\n/);
  assert.equal((await saved()).scripts.find((x: { name: string }) => x.name === "Lena's Film").author, 'Lena Weber', 'the server keeps it');
});

test('board cards add with act and read bottom to top', async () => {
  const reply = await ok('act', { do: [['addBoardItems', [{ kind: 'note', text: 'Warm light', x: 10, y: 20 }, { kind: 'swatch', color: '#AABBCC', x: 300.4, y: 20 }]]] });
  assert.match(reply, /\+ board card @\w+ note "Warm light"\n\+ board card @\w+ swatch #aabbcc/);
  assert.match(await job('plan', { view: 'board' }), /^2 board cards, bottom to top:\n@\w+ note "Warm light" #f2c878 at 10,20 220x160\n@\w+ swatch #aabbcc at 300,20 120x150$/);
  assert.match((await tool('act', { do: [['addBoardItems', [{ kind: 'image' }]]] })).text, /refused: Pick an image or video from this project/);
  assert.equal((await saved()).boardItems.length, 2);
});

test('the media list marks a take with its shot', async () => {
  await ok('media');
  const s = store.getState(), shot = s.shots.find(x => x.projectId === s.projectId)!;
  const asset = (id: string, name: string) => ({ id, projectId: s.projectId, name, kind: 'video', binId: 'broll', thumbnail: '', duration: 2, resolution: '1920 x 1080', fps: 24, size: '', status: 'ready', progress: 100 });
  const view = mediaView({ ...s, media: [asset('take-1', '1A_take2.mov'), asset('other-1', 'IMG_0003.mov')] as any });
  assert.match(view, new RegExp(`@take-1 video "1A_take2\\.mov" .* · shot 1A @${shot.id.slice(5, 13)}\n@other-1 video "IMG_0003\\.mov" [^·]*$`));
});
