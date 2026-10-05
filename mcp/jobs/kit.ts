// Shared pieces for job modules (mcp/jobs/*.ts). A job module exports `jobs` (kind -> JobDef) and optionally
// `topics` (help topic -> text). A job either finishes inside start() or returns a Poller; mcp/jobs.ts then waits
// up to the caller's `wait` and hands back an id to poll if the work is still going.
import { useEditorStore as store } from '../../src/state/store.ts';
import type { Clip, MediaAsset, Timeline } from '../../src/state/models.ts';
import { call, ApiFailure, refresh } from '../session.ts';
import { edit, shown, findTimeline } from '../edit.ts';
import { handle } from '../views.ts';

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
/** `text` is what the model reads; `content` (images) is added after it. */
export interface Step { done: boolean; text: string; content?: Content[] }
export interface Poller { label: string; poll(): Promise<Step>; cancel?(): Promise<void> }
export interface JobDef {
  /** One line for help{topic:"jobs"}: the params and what comes back. Keep it short; it is the job's whole manual. */
  doc: string;
  start(params: Record<string, any>): Promise<Step | Poller>;
}

export { store, call, ApiFailure, refresh, edit, shown, handle, findTimeline };
export const done = (text: string, content?: Content[]): Step => ({ done: true, text, ...(content ? { content } : {}) });
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const isPoller = (value: Step | Poller): value is Poller => typeof (value as Poller).poll === 'function';

/** A required parameter, with an error the model can act on. */
export function need<T = string>(params: Record<string, any>, key: string, type: 'string' | 'number' | 'boolean' | 'object' | 'array' = 'string'): T {
  const value = params[key];
  const ok = type === 'array' ? Array.isArray(value) : type === 'object' ? value && typeof value === 'object' && !Array.isArray(value) : typeof value === type && (type !== 'number' || Number.isFinite(value));
  if (!ok) throw new Error(`params.${key} (${type}) is required.`);
  return value as T;
}

export function project() {
  const s = store.getState(), p = s.projects.find(x => x.id === s.projectId);
  if (!p) throw new Error('No project open. Use projects{open:"name"}.');
  return p;
}
export function clip(id: unknown): Clip {
  const s = store.getState(), found = s.clips.find(c => c.id === id);
  if (!found) throw new Error(`No clip ${handle(String(id))}. Look at the timeline again.`);
  // Store actions silently ignore a clip outside the open project, so say which project to open.
  if (found.projectId !== s.projectId) { const name = s.projects.find(p => p.id === found.projectId)?.name ?? found.projectId; throw new Error(`${handle(found.id)} is in project "${name}"; open it first: projects{open:${JSON.stringify(name)}}.`); }
  return found;
}
export function media(id: unknown): MediaAsset {
  const found = store.getState().media.find(m => m.id === id);
  if (!found) throw new Error(`No media ${handle(String(id))}. Look at the media list again.`);
  return found;
}
export function timeline(id?: unknown): Timeline {
  const s = store.getState();
  if (id === undefined || id === null || id === '') { const t = s.timelines.find(x => x.id === s.timelineId); if (!t) throw new Error('No timeline open.'); return t; }
  return findTimeline(String(id));
}
/** Fetch a server file (an export, a preview image) as bytes. */
export async function bytes(path: string): Promise<Buffer> {
  const data = await call<Buffer>(path.replace(/^\/api/, ''));
  if (!Buffer.isBuffer(data)) throw new Error(`Expected a file from ${path}.`);
  return data;
}
/** An image the model can look at. */
export const image = (data: Buffer, mimeType = 'image/jpeg'): Content => ({ type: 'image', data: data.toString('base64'), mimeType });
