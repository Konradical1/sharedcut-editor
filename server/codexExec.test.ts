import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { outputSchema, validateOutput } from '../src/services/colorAssistant.ts';
import { codexArgs, codexCommand, codexShimError, execCodex, fakeOutput, runCodex } from './codexExec.ts';

const withEnv = async <T,>(values: Record<string, string | undefined>, work: () => T | Promise<T>): Promise<T> => {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  const set = (entries: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(entries)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  set(values);
  try { return await work(); } finally { set(previous); }
};

test('codex argv is the audited list: one -i per image, prompt from stdin last', () => {
  assert.deepEqual(codexArgs({ model: 'gpt-6-astra', effort: 'medium', dir: 'T', images: ['a.jpg', 'b.jpg'], schemaPath: 'T/schema.json', outPath: 'T/out.json' }), [
    'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
    '--disable', 'shell_tool', '--disable', 'image_generation', '--disable', 'apps', '--disable', 'plugins', '--disable', 'browser_use',
    '--disable', 'computer_use', '--disable', 'multi_agent', '--disable', 'hooks', '--disable', 'view_image', '--disable', 'skill_search', '--disable', 'tool_suggest', '--disable', 'goals', '--disable', 'sleep_tool',
    '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'model_reasoning_effort="medium"',
    '-m', 'gpt-6-astra', '-C', 'T', '-i', 'a.jpg', '-i', 'b.jpg', '--output-schema', 'T/schema.json', '-o', 'T/out.json', '-']);
  assert.throws(() => codexArgs({ model: 'm', effort: 'high" x', dir: 'T', images: [], schemaPath: 's', outPath: 'o' }), /FRAME_LINE_AI_EFFORT/);
});

test('the executable honours FRAME_LINE_CODEX, else the vendored Windows exe or codex on PATH', () => withEnv({ FRAME_LINE_CODEX: undefined, APPDATA: undefined }, async () => {
  const vendor = join('npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
  assert.equal(codexCommand('win32', 'x64'), join(homedir(), 'AppData', 'Roaming', vendor, 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'));
  process.env.APPDATA = join('R', 'Roaming');
  assert.equal(codexCommand('win32', 'arm64'), join('R', 'Roaming', vendor, 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'));
  assert.equal(codexCommand('darwin', 'arm64'), 'codex');
  process.env.FRAME_LINE_CODEX = join('x', 'codex');
  assert.equal(codexCommand('win32', 'x64'), join('x', 'codex'));
}));

test('the npm codex.cmd shim is refused on Windows with a readable reason, the vendored exe is not', () => {
  assert.match(codexShimError(join('C:', 'Users', 'k', 'AppData', 'Roaming', 'npm', 'codex.CMD'), 'win32')!, /codex\.exe/);
  assert.equal(codexShimError(join('x', 'codex.bat'), 'darwin'), undefined);
  assert.equal(codexShimError(join('x', 'bin', 'codex.exe'), 'win32'), undefined);
});

test('runCodex rejects comma image paths and unknown providers before spawning', () => withEnv({ FRAME_LINE_CODEX: join(tmpdir(), 'missing-codex'), FRAME_LINE_AI_PROVIDER: undefined }, async () => {
  await assert.rejects(runCodex({ prompt: 'p', images: [join(tmpdir(), 'a,b.jpg')], schema: {} }), /commas/);
  process.env.FRAME_LINE_AI_PROVIDER = 'openai';
  await assert.rejects(runCodex({ prompt: 'p', images: [], schema: {} }), /FRAME_LINE_AI_PROVIDER/);
  process.env.FRAME_LINE_AI_PROVIDER = 'codex';
  await assert.rejects(runCodex({ prompt: 'p', images: [], schema: {} }), /Codex CLI not found/);
}));

const rgb = { type: 'object', additionalProperties: false, required: ['r', 'g', 'b'], properties: { r: { type: 'number', minimum: -.4, maximum: .4 }, g: { type: 'number', minimum: -.4, maximum: .4 }, b: { type: 'number', minimum: -.4, maximum: .4 } } };
const shot = { type: 'object', required: ['clipId', 'confidence', 'warnings'], properties: { clipId: { type: 'string', enum: ['c1', 'c2'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, warnings: { type: 'array', maxItems: 8, items: { type: 'object', properties: { code: { type: 'string', enum: ['clipping', 'other'] }, text: { type: 'string', maxLength: 300 } } } } } };

test('the fake provider answers with neutral, in-range values and one item per shot or intensity', async () => {
  const schema = { type: 'object', required: ['options'], properties: { options: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'object', properties: {
    name: { type: 'string', maxLength: 5 }, intensity: { type: 'string', enum: ['natural', 'bold', 'extreme'] },
    look: { type: 'object', properties: { contrast: { type: 'number', minimum: .5, maximum: 2.5 }, pivot: { type: 'number', minimum: .15, maximum: .65 }, saturation: { type: 'number', minimum: 0, maximum: 200 }, gain: { type: 'number', minimum: .6, maximum: 1.4 }, gainRgb: rgb, curve: { type: 'array', maxItems: 8, items: {} } } },
    shots: { type: 'array', items: shot } } } } } };
  const value = await withEnv({ FRAME_LINE_AI_PROVIDER: 'fake' }, () => runCodex({ prompt: 'p', images: [], schema })) as { options: { name: string; intensity: string; look: object; shots: { clipId: string; warnings: unknown[] }[] }[] };
  assert.deepEqual(value.options.map(option => option.intensity), ['natural', 'bold', 'extreme']);
  assert.deepEqual(value.options[0].look, { contrast: 1, pivot: .15, saturation: 100, gain: 1, gainRgb: { r: 0, g: 0, b: 0 }, curve: [] });
  assert.equal(value.options[2].name, 'Fake ');
  assert.deepEqual(value.options[1].shots, [{ clipId: 'c1', confidence: 0, warnings: [] }, { clipId: 'c2', confidence: 0, warnings: [] }]);
  assert.deepEqual(fakeOutput({ type: 'array', maxItems: 1, items: shot }), [{ clipId: 'c1', confidence: 0, warnings: [] }]);
});

test('fake output passes the shared validator for looks, balance and match', () => {
  for (const mode of ['looks', 'balance', 'match'] as const) assert.ok(validateOutput(mode, fakeOutput(outputSchema(mode, ['c1', 'c2'])), ['c1', 'c2']), mode);
});

const stub = (body: string) => ['-e', `const fs=require('node:fs');${body}`];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('execCodex: stdin prompt, JSON answer, redacted failures, bad JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frameline-codex-test-'));
  try {
    const out = join(directory, 'out.json');
    assert.deepEqual(await execCodex(process.execPath, [...stub(`let s='';process.stdin.on('data',d=>s+=d).on('end',()=>fs.writeFileSync(process.argv[1],JSON.stringify({ok:true,prompt:s})))`), out], 'hello', out), { ok: true, prompt: 'hello' });
    await assert.rejects(execCodex(process.execPath, stub(`process.stderr.write('401 token sk-abcdefghijklmnopqrst expired');process.exit(3)`), 'p', out), (error: Error) => /exited 3\). 401 token \[redacted\] expired$/.test(error.message) && !error.message.includes('sk-abc'));
    await assert.rejects(execCodex(process.execPath, [...stub(`fs.writeFileSync(process.argv[1],'not json')`), out], 'p', out), /no valid JSON/);
    await assert.rejects(execCodex(process.execPath, stub(''), 'p', join(directory, 'missing.json')), /no valid JSON/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('execCodex kills the whole tree on timeout and on cancel', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frameline-codex-test-'));
  try {
    const spawner = (file: string) => [...stub(`const c=require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(c.pid));setTimeout(()=>{},60000)`), file];
    const waitFor = async (file: string) => { for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 50)); return Number(await readFile(file, 'utf8')); };
    const gone = async (pid: number) => { for (let i = 0; i < 40 && alive(pid); i++) await new Promise(r => setTimeout(r, 50)); return !alive(pid); };

    const slow = join(directory, 'slow.pid'), timedOut = execCodex(process.execPath, spawner(slow), 'p', join(directory, 'o.json'), undefined, 1500);
    const slowChild = await waitFor(slow);
    await assert.rejects(timedOut, /timed out after 2 s/);
    assert.ok(await gone(slowChild), 'the grandchild died with the timed-out process');

    const controller = new AbortController(), cancel = join(directory, 'cancel.pid');
    const cancelled = execCodex(process.execPath, spawner(cancel), 'p', join(directory, 'o.json'), controller.signal);
    const cancelChild = await waitFor(cancel);
    controller.abort();
    await assert.rejects(cancelled, /cancelled/);
    assert.ok(await gone(cancelChild), 'the grandchild died with the cancelled process');
    await assert.rejects(execCodex(process.execPath, stub(''), 'p', 'o', controller.signal), /cancelled/);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
});
