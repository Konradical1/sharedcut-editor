// SharedCut MCP server: lets Claude, Codex or any MCP client edit SharedCut projects. It speaks MCP over stdio
// (newline-delimited JSON-RPC) and drives the editor's own store, so an edit here is the same edit the UI makes,
// lands in History, and can be undone by the same account. See mcp/README.md to install.
//
//   node mcp/server.ts            (Node >= 22.18; the SharedCut checkout must have node_modules)
import './env.ts';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { useEditorStore as store } from '../src/state/store.ts';
import { refresh, call, ApiFailure } from './session.ts';
import { projectsView, timelineView, mediaView, entityView, resolveHandles } from './views.ts';
import { help } from './catalog.ts';
import { ready, act, findProject, openTimeline, cap, takeSwitchNote } from './edit.ts';
import { runJob, jobStatus, JOB_KINDS } from './jobs.ts';
import { frame } from './frame.ts';

const VERSION = '1.0.0';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = `SharedCut is a collaborative video editor. This server edits the user's real projects on the server; open editors see changes live and can undo them.
Workflow: projects -> projects{open} -> timeline -> act / job -> timeline or frame to check. help{topic} has the catalogs (actions, effects, transitions, titles, shapes, color, properties, jobs).
Ids print as @handles (e.g. @3fa9c1d2); pass them back as-is. Times are seconds. Prefer one act call with several steps over many calls.`;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Tool = { description: string; inputSchema: Record<string, unknown>; run(args: any): Promise<string | Content[]> };
const str = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' };
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOLS: Record<string, Tool> = {
  projects: {
    description: 'List projects, or open one by name/@handle (then shows its timeline).',
    inputSchema: schema({ open: { ...str, description: 'Project name or @handle to open' } }),
    async run({ open }) {
      const s = await ready();
      if (!open) return projectsView(s);
      s.openProject(findProject(open).id);
      return cap(timelineView(store.getState()), 'use timeline{from,to,track}');
    },
  },
  timeline: {
    description: 'The open timeline: tracks and clips, one line each. Filter with from/to (seconds) or track (V1, A2, name, @handle).',
    inputSchema: schema({ timeline: { ...str, description: 'Switch to this timeline (name or @handle) first' }, from: num, to: num, track: str }),
    async run({ timeline, from, to, track }) {
      await ready();
      if (timeline) openTimeline(timeline);
      return cap(timelineView(store.getState(), { from, to, track }), 'narrow with from/to/track');
    },
  },
  media: {
    description: 'Media in the open project (bins, status, length, format). filter matches name or bin id.',
    inputSchema: schema({ filter: str }),
    async run({ filter }) { return cap(mediaView(await ready(), filter), 'use filter'); },
  },
  get: {
    description: 'Full JSON of one thing by @handle (clip, track, grade node, media, timeline, effect, mask, marker, comment, export…). path drills in, e.g. "properties" or "keyframes".',
    inputSchema: schema({ id: str, path: str, full: { ...bool, description: 'Do not shorten long arrays' } }, ['id']),
    async run({ id, path, full }) { const s = await ready(); return entityView(resolveHandles(id, s), s, path, full); },
  },
  act: {
    description: 'Edit: run editor actions in order, saved as one batch (all or nothing). do: [["splitClip","@id"],["moveClip","@id",12.5]]. Optional at (playhead), select (clip handles), timeline set context first. help{topic:"actions"} lists actions.',
    inputSchema: schema({
      do: { type: 'array', items: { type: 'array' }, description: '[[action, ...args], ...]' },
      at: { ...num, description: 'Playhead seconds before running' },
      select: { type: 'array', items: str, description: 'Clip @handles to select first' },
      timeline: str,
    }, ['do']),
    run: act,
  },
  job: {
    description: 'Server work: upload files, import links, captions, smart masks, depth, stabilize, optical flow, tracking, color assistant, exports, Resolve, sound effects, fonts. kind + params; returns when done or after wait seconds (then poll with kind "status" + id). help{topic:"jobs"} lists kinds.',
    inputSchema: schema({ kind: { type: 'string', enum: [...JOB_KINDS, 'status', 'cancel'] }, id: { ...str, description: 'Job id to poll (kind "status")' }, wait: { ...num, description: 'Seconds to wait, default 45' }, params: { type: 'object', description: 'Kind-specific, see help jobs' } }, ['kind']),
    async run({ kind, id, wait, params }) {
      await ready();
      if (kind === 'status') return jobStatus(String(id ?? ''), wait);
      return runJob(kind, resolveHandles(params ?? {}, store.getState()), wait);
    },
  },
  frame: {
    description: 'See the picture: the final timeline frame at time (default playhead), rendered like Export; or a clip/media source frame (ungraded). n>1 makes one contact sheet over from..to. help visual.',
    inputSchema: schema({ time: num, clip: { ...str, description: 'Clip @handle: its source frame at time (timeline s)' }, media: { ...str, description: 'Media @handle: frame at time seconds into the file' }, width: { ...num, description: 'Pixels, default 512 (sheet cell 256), max 1280' }, n: { ...num, description: 'Contact sheet: this many frames (2-16) in one image' }, from: num, to: num }),
    async run(args) { const s = await ready(); return frame(resolveHandles(args, s)); },
  },
  help: {
    description: 'Reference on demand: actions, effects, transitions, titles, shapes, properties, keyframes, jobs, and one topic per feature (media, color, audio, visual…). No topic lists them; filter narrows.',
    inputSchema: schema({ topic: str, filter: str }),
    async run({ topic, filter }) { return help(topic, filter); },
  },
  api: {
    description: 'Escape hatch: call any SharedCut /api endpoint as the signed-in user and get its JSON (shortened); save writes a file reply to a local path. Use only when no other tool covers it.',
    inputSchema: schema({ method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { ...str, description: 'e.g. /api/renders' }, body: { type: 'object' }, save: { ...str, description: 'Local file path for a file reply' } }, ['path']),
    async run({ method = 'GET', path, body, save }) {
      await ready();
      const route = String(path).replace(/^\/?(api\/)?/, '/');
      // Signing out would revoke the session this server runs on (and release the user's locks everywhere).
      if (/^\/auth\/(logout|login|signup)/.test(route)) throw new Error('Sign-in routes are off limits here; use npm run mcp:login.');
      const data = await call(route, { method, ...(body !== undefined ? { json: resolveHandles(body, store.getState()) } : {}) });
      if (method !== 'GET') await refresh();
      if (save) {
        const file = resolve(String(save).replace(/^~(?=$|[\\/])/, homedir()));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2));
        return `saved ${file} (${Buffer.isBuffer(data) ? data.length : 'JSON'} bytes)`;
      }
      const text = Buffer.isBuffer(data) ? `(${data.length} bytes of binary)` : JSON.stringify(data, (_k, v) => Array.isArray(v) && v.length > 50 ? [...v.slice(0, 50), `…${v.length - 50} more`] : v);
      return text.length > 12_000 ? `${text.slice(0, 12_000)}… (${text.length} chars total; narrow the request)` : text;
    },
  },
};

let queue: Promise<unknown> = Promise.resolve();
export async function answer(message: { method: string; params?: any }): Promise<unknown> {
  const { method, params } = message;
  if (method === 'initialize') {
    const asked = params?.protocolVersion;
    return { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'sharedcut', title: 'SharedCut', version: VERSION }, instructions: INSTRUCTIONS };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: Object.entries(TOOLS).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })) };
  if (method === 'tools/call') {
    const tool = TOOLS[params?.name];
    if (!tool) throw Object.assign(new Error(`Unknown tool ${params?.name}`), { code: -32602 });
    // One call at a time: every tool reads and writes the same store.
    const run = queue.then(() => tool.run(params.arguments ?? {}));
    queue = run.catch(() => {});
    try {
      const out = await run, note = takeSwitchNote(), content: Content[] = typeof out === 'string' ? [{ type: 'text', text: out }] : out;
      if (note) content.unshift({ type: 'text', text: note });
      return { content };
    } catch (error) {
      const text = error instanceof ApiFailure ? `SharedCut said: ${error.message}` : error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text }], isError: true };
    }
  }
  if (method === 'resources/list') return { resources: [] };
  if (method === 'prompts/list') return { prompts: [] };
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

function send(message: unknown) { process.stdout.write(JSON.stringify(message) + '\n'); }
async function receive(message: any) {
  // Notifications (initialized, cancelled) carry no id and get no answer.
  if (!message || typeof message !== 'object' || message.id === undefined || message.id === null) return;
  try { send({ jsonrpc: '2.0', id: message.id, result: await answer(message) }); }
  catch (error: any) { send({ jsonrpc: '2.0', id: message.id, error: { code: error?.code ?? -32603, message: error?.message ?? String(error) } }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // stdout is the protocol channel: anything the app's modules print goes to stderr.
  console.log = console.info = console.warn = console.debug = (...args: unknown[]) => { process.stderr.write(args.map(String).join(' ') + '\n'); };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    if (!line.trim()) return;
    let message: any;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    for (const one of Array.isArray(message) ? message : [message]) void receive(one);
  });
  lines.on('close', () => process.exit(0));
}
