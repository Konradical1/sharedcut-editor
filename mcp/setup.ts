// Sign the MCP in and register it with Claude Code and Codex.
//
//   npm run mcp:setup                 sign in, then register with every CLI found (claude, codex)
//   npm run mcp:login [url]           sign in only (default https://sharedcut.com); the session lasts 30 days
//   npm run mcp:install               register only
//
// The session is saved to ~/sharedcut-agent/mcp.json (mode 600). FRAME_LINE_URL / FRAME_LINE_COOKIE override it.
import './env.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { CONFIG_FILE, DEFAULT_URL, config } from './session.ts';

// server.mjs beside a bundled setup.mjs, server.ts in the repo.
const SERVER = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './server.ts' : './server.mjs', import.meta.url));

async function ask(question: string, hidden = false): Promise<string> {
  if (!hidden || !process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(question)).trim(); } finally { rl.close(); }
  }
  // A password is read in raw mode so it is never echoed.
  process.stdout.write(question);
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  return new Promise((done, fail) => {
    let value = '';
    const finish = (then: () => void) => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); then(); };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return finish(() => done(value));
        if (char === '\u0003') return finish(() => fail(new Error('Cancelled.')));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1); else value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function login(urlArg?: string) {
  const fallback = config().url || DEFAULT_URL;
  const url = (urlArg || (await ask(`SharedCut address [${fallback}]: `)) || fallback).replace(/\/$/, '');
  const email = await ask('Email: '), password = await ask('Password: ', true);
  const response = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const data = await response.json().catch(() => ({})) as { user?: { name: string }; error?: string };
  if (!response.ok) throw new Error(data.error ?? `Sign-in failed (${response.status}).`);
  const token = /frameline_session=([^;]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
  if (!token) throw new Error('The server did not return a session.');
  mkdirSync(dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_FILE, JSON.stringify({ url, cookie: `frameline_session=${token}`, email, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(`Signed in to ${url} as ${data.user?.name ?? email}. The session lasts 30 days; run npm run mcp:login again after that.`);
}

function register(cli: string, add: string[], remove: string[]) {
  const shell = process.platform === 'win32'; // claude/codex are .cmd shims on Windows
  if (spawnSync(cli, ['--version'], { stdio: 'ignore', shell }).status !== 0) { console.log(`- ${cli}: not found, skipped`); return; }
  spawnSync(cli, remove, { stdio: 'ignore', shell });
  const quoted = (arg: string) => shell && /\s/.test(arg) ? `"${arg}"` : arg;
  const result = spawnSync(cli, [...add, '--', quoted(process.execPath), quoted(SERVER)], { stdio: 'inherit', shell });
  console.log(result.status === 0 ? `- ${cli}: registered as "sharedcut"` : `- ${cli}: registration failed; add it by hand (see mcp/README.md)`);
}
export function install() {
  console.log(`Registering ${SERVER}`);
  register('claude', ['mcp', 'add', '--scope', 'user', 'sharedcut'], ['mcp', 'remove', '--scope', 'user', 'sharedcut']);
  register('codex', ['mcp', 'add', 'sharedcut'], ['mcp', 'remove', 'sharedcut']);
  console.log('Restart Claude Code / Codex to load it, then ask: "open my latest SharedCut project and show the timeline".');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command = 'setup', url] = process.argv.slice(2);
  try {
    if (command === 'login' || command === 'setup') await login(url);
    if (command === 'install' || command === 'setup') install();
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
}
