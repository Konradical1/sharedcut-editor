import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { killProcessTree } from './processTree.ts';

export const aiModel = () => process.env.FRAME_LINE_AI_MODEL || 'gpt-6-astra';
export const aiEffort = () => process.env.FRAME_LINE_AI_EFFORT || 'medium';
export const aiProvider = () => process.env.FRAME_LINE_AI_PROVIDER || 'codex';

/** The npm `codex.cmd` shim needs a shell, so Windows spawns the vendored codex.exe directly. APPDATA can be unset under the S4U task. */
export function codexCommand(platform = process.platform, arch = process.arch) {
  if (process.env.FRAME_LINE_CODEX) return process.env.FRAME_LINE_CODEX;
  if (platform !== 'win32') return 'codex';
  const [pkg, triple] = arch === 'arm64' ? ['codex-win32-arm64', 'aarch64-pc-windows-msvc'] : ['codex-win32-x64', 'x86_64-pc-windows-msvc'];
  return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', pkg, 'vendor', triple, 'bin', 'codex.exe');
}

// --ignore-user-config drops Konrad's MCP servers, hooks and skills, and with them the model and effort, so both are passed.
// Every tool is off: the model only looks at the stills and answers with schema JSON. `-` (prompt on stdin) must stay last.
export function codexArgs(o: { model: string; effort: string; dir: string; images: string[]; schemaPath: string; outPath: string }) {
  if (!/^[a-z]+$/.test(o.effort)) throw new Error(`FRAME_LINE_AI_EFFORT must be a Codex reasoning effort such as medium, not "${o.effort}".`);
  return ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
    ...['shell_tool', 'image_generation', 'apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent', 'hooks', 'view_image', 'skill_search', 'tool_suggest', 'goals', 'sleep_tool'].flatMap(feature => ['--disable', feature]),
    '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', `model_reasoning_effort="${o.effort}"`,
    '-m', o.model, '-C', o.dir, ...o.images.flatMap(image => ['-i', image]), '--output-schema', o.schemaPath, '-o', o.outPath, '-'];
}

export const codexShimError = (command: string, platform = process.platform) => platform === 'win32' && /\.(cmd|bat)$/i.test(command) ? 'FRAME_LINE_CODEX must point at codex.exe; Node cannot run the npm codex.cmd shim without a shell.' : undefined;
const redact = (text: string) => text.replace(/(sk-|eyJ)[A-Za-z0-9._-]{10,}|[A-Za-z0-9._-]{40,}/g, '[redacted]');

/** Runs one Codex process: prompt on stdin, answer read from `outPath`. Rejects only after the process tree is gone. */
export function execCodex(command: string, args: string[], prompt: string, outPath: string, signal?: AbortSignal, timeoutMs = 180_000): Promise<unknown> {
  if (signal?.aborted) return Promise.reject(new Error('AI request cancelled.'));
  const shim = codexShimError(command); if (shim) return Promise.reject(new Error(shim));
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, detached: process.platform !== 'win32' });
    let errors = '', failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; killProcessTree(child); };
    const abort = () => stop(new Error('AI request cancelled.'));
    const timer = setTimeout(() => stop(new Error(`The AI request timed out after ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.resume(); // The answer comes from -o; stdout only echoes it.
    child.stderr.on('data', data => { errors = (errors + data).slice(-4000); });
    child.stdin.on('error', () => { /* EPIPE when Codex dies before reading the prompt; its exit code reports why. */ });
    child.on('error', error => { failure ??= (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Codex CLI not found at ${command}. Install it or set FRAME_LINE_CODEX.`) : error; });
    child.on('close', async code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`The AI request failed (Codex exited ${code}). ${redact(errors).trim().slice(-500)}`.trim()));
      try { resolveOutput(JSON.parse(await readFile(outPath, 'utf8'))); } catch { reject(new Error('The AI returned no valid JSON.')); }
    });
    child.stdin.end(prompt);
  });
}

// ponytail: one global chain, one Codex job stream per auth.json; per-account chains if an API-key provider arrives.
let queue: Promise<unknown> = Promise.resolve();

export async function runCodex({ prompt, images, schema, signal, timeoutMs = 180_000 }: { prompt: string; images: string[]; schema: object; signal?: AbortSignal; timeoutMs?: number }): Promise<unknown> {
  const provider = aiProvider();
  if (provider !== 'codex' && provider !== 'fake') throw new Error(`FRAME_LINE_AI_PROVIDER must be codex or fake, not "${provider}".`);
  if (signal?.aborted) throw new Error('AI request cancelled.');
  if (provider === 'fake') return fakeOutput(schema);
  const paths = images.map(image => resolve(image)); // cwd is the temp dir, so relative paths would miss.
  for (const path of paths) if (path.includes(',')) throw new Error(`Codex splits -i on commas; rename ${path}.`);
  const task = queue.then(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'frameline-codex-'));
    try {
      const schemaPath = join(dir, 'schema.json'), outPath = join(dir, 'out.json');
      await writeFile(schemaPath, JSON.stringify(schema));
      return await execCodex(codexCommand(), codexArgs({ model: aiModel(), effort: aiEffort(), dir, images: paths, schemaPath, outPath }), prompt, outPath, signal, timeoutMs);
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => { /* A Windows lock must not replace the answer or the real error; the OS temp dir is cleaned eventually. */ }); }
  });
  queue = task.then(() => {}, () => {});
  return task;
}

type Schema = { type?: string | string[]; enum?: unknown[]; anyOf?: Schema[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; minItems?: number; maxItems?: number; minimum?: number; maximum?: number; minLength?: number; maxLength?: number };
const neutral: Record<string, number> = { saturation: 100, gain: 1, contrast: 1 };

/** Test provider: the most neutral value the schema allows. Arrays of shots or looks get one item per clipId/intensity enum value, in order. */
export function fakeOutput(schema: Schema, name = '', index = 0): unknown {
  if (schema.anyOf) return fakeOutput(schema.anyOf[0], name, index);
  if (schema.enum) return schema.enum[(name === 'clipId' || name === 'intensity') ? index % schema.enum.length : 0];
  const type = Array.isArray(schema.type) ? schema.type.find(t => t !== 'null') : schema.type;
  if (type === 'object') return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, value]) => [key, fakeOutput(value, key, index)]));
  if (type === 'array') {
    const item = schema.items ?? {}, keyed = item.properties?.clipId?.enum ?? item.properties?.intensity?.enum;
    const count = Math.min(schema.maxItems ?? Infinity, Math.max(schema.minItems ?? 0, keyed?.length ?? 0));
    return Array.from({ length: count }, (_, i) => fakeOutput(item, '', i));
  }
  if (type === 'number' || type === 'integer') {
    const value = neutral[name] ?? 0, min = schema.minimum ?? -Infinity, max = schema.maximum ?? Infinity;
    return value >= min && value <= max ? value : min;
  }
  if (type === 'string') return `Fake ${name || 'text'}`.padEnd(schema.minLength ?? 0, '.').slice(0, schema.maxLength ?? Infinity);
  if (type === 'boolean') return false;
  return null;
}
