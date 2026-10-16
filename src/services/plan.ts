// Plan workspace rules shared by the store actions, the server's save validation, the exports and the MCP.
// Pure and DOM-free: the headless MCP and the server import it.
import type { BoardItemKind, PlanTab, ScriptBlock, ScriptBlockKind, ScriptFormat, Shot } from '../state/models.ts';

export const PLAN_TABS: readonly PlanTab[] = ['script', 'shots', 'board'];
export const SCRIPT_FORMATS: readonly ScriptFormat[] = ['screenplay', 'stage'];
export const SCRIPT_BLOCK_KINDS: readonly ScriptBlockKind[] = ['scene', 'action', 'character', 'parenthetical', 'dialogue', 'transition', 'shot', 'lyric', 'note'];
export const BOARD_ITEM_KINDS: readonly BoardItemKind[] = ['image', 'note', 'text', 'swatch'];
// One set of caps for the store's clamps and the server's refusals, so a save the editor allows is never refused.
export const PLAN_LIMITS = { blockText: 20_000, shotText: 2_000, shotNotes: 5_000, shotNumber: 16, field: 255, mediaIds: 100, boardText: 5_000, coord: 1e6, minSize: 8, maxSize: 20_000 } as const;
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Sorted copy by `order`; ties break by id so every client reads the same sequence. */
export const ordered = <T extends { order: number; id: string }>(items: readonly T[]) => [...items].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** An order value between two neighbours, either of which may be missing. */
export const orderBetween = (prev?: number, next?: number) => prev === undefined ? (next === undefined ? 1 : next - 1) : next === undefined ? prev + 1 : (prev + next) / 2;

// ponytail: midpoint inserts halve the gap each time; after ~50 inserts at one spot the floats meet and the caller renumbers the list.
/** True once two neighbours are too close to split again. */
export const crowded = (prev?: number, next?: number) => prev !== undefined && next !== undefined && !(next - prev > 1e-9 * Math.max(1, Math.abs(prev)));

/** Scene numbers (1-based, reading order) of one script's scene blocks. */
export function sceneNumbers(blocks: readonly ScriptBlock[]) {
  const numbers = new Map<string, number>();
  for (const block of ordered(blocks)) if (block.kind === 'scene') numbers.set(block.id, numbers.size + 1);
  return numbers;
}

const SCENE_SHOT = /^(\d+)([A-Z]{1,2})$/;
const letterIndex = (letters: string) => letters.length === 1 ? letters.charCodeAt(0) - 65 : (letters.charCodeAt(0) - 64) * 26 + letters.charCodeAt(1) - 65;
const letters = (index: number) => index < 26 ? String.fromCharCode(65 + index) : String.fromCharCode(64 + Math.floor(index / 26)) + String.fromCharCode(65 + index % 26);

/** The next shot number: after the highest letter under scene `scene` ("3A" → "3B"), else after the highest plain number ("4" → "5"). */
export function nextShotNumber(shots: readonly Pick<Shot, 'number'>[], scene?: number) {
  const codes = shots.map(shot => shot.number.trim().toUpperCase());
  if (scene !== undefined) return `${scene}${letters(Math.max(-1, ...codes.map(code => SCENE_SHOT.exec(code)).filter(match => match && +match[1] === scene).map(match => letterIndex(match![2]))) + 1)}`;
  return String(Math.max(0, ...codes.filter(code => /^\d+$/.test(code)).map(Number)) + 1);
}
