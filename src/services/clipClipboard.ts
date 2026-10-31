import type { Clip, GradeNode, Track } from '../state/models.ts';
export interface ClipClipboard { userId: string; clipboard: Clip; clipboardClips: Clip[]; clipboardNodes: GradeNode[]; tracks: Track[] }
const key = (user: string) => `sharedcut.clipboard.v1.${user}`;
export function saveClipClipboard(value: ClipClipboard) {
  try { localStorage.setItem(key(value.userId), JSON.stringify(value)); } catch { /* In-memory copying still works. */ }
  if (typeof navigator !== 'undefined') void navigator.clipboard?.writeText(`sharedcut:clips:${JSON.stringify(value)}`).catch(() => {});
}
export function readClipClipboard(userId: string): ClipClipboard | null {
  try { const value = JSON.parse(localStorage.getItem(key(userId)) || 'null'); return value?.userId === userId && Array.isArray(value.clipboardClips) && Array.isArray(value.tracks) ? value : null; } catch { return null; }
}
