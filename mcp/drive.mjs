// Drive the MCP over stdio the way a client does, for testing against a throwaway server:
//   FRAME_LINE_URL=http://127.0.0.1:4401 FRAME_LINE_COOKIE='frameline_session=…' node mcp/drive.mjs '[["timeline",{}],["act",{"do":[["addTitle",0]]}]]'
// Images print as a size marker; set DRIVE_IMAGES=<dir> to save them there. DRIVE_SERVER=<path> drives another build (a bundle).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', process.env.DRIVE_SERVER ?? fileURLToPath(new URL('./server.ts', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = '', id = 0, saved = 0;
const waiting = new Map();
child.stdout.on('data', chunk => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf('\n')) >= 0;) { const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1); waiting.get(message.id)?.(message); }
});
const rpc = (method, params) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'drive', version: '0' } });
for (const [name, args] of JSON.parse(process.argv[2] ?? '[]')) {
  const message = await rpc('tools/call', { name, arguments: args });
  const parts = (message.result?.content ?? []).map(c => {
    if (c.type !== 'image') return c.text;
    if (process.env.DRIVE_IMAGES) { const file = join(process.env.DRIVE_IMAGES, `image-${++saved}.jpg`); writeFileSync(file, Buffer.from(c.data, 'base64')); return `[image saved to ${file}]`; }
    return `[image ${c.mimeType} ${Math.round(c.data.length * 3 / 4 / 1024)} KB]`;
  });
  console.log(`\n### ${name} ${JSON.stringify(args)}${message.result?.isError ? ' [ERROR]' : ''}\n${parts.join('\n') || JSON.stringify(message.error)}`);
}
child.kill();
